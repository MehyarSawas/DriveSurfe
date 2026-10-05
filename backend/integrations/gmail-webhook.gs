/**
 * DriveSurfe — Gmail → webhook forwarder (Google Apps Script).
 *
 * Runs inside YOUR Google account (script.google.com), so no Gmail OAuth
 * client or Pub/Sub project is needed on the DriveSurfe side. Every minute
 * it forwards new inbox messages (incl. attachments) to
 * POST {DS_WEBHOOK_URL}, signed with HMAC-SHA256.
 *
 * Setup:
 *  1. script.google.com → New project → paste this file.
 *  2. Project Settings → Script properties:
 *       DS_WEBHOOK_URL    = https://your-domain.com/api/hooks/gmail
 *       DS_WEBHOOK_SECRET = same value as MAIL_WEBHOOK_SECRET in backend/.env
 *       DS_SEARCH_QUERY   = (optional) Gmail search, default "in:inbox newer_than:2d"
 *  3. Run `setup` once (grants Gmail access, installs a 1-minute trigger).
 *     Only mail received AFTER setup is forwarded.
 *
 * Signature: X-DS-Timestamp = unix seconds,
 *            X-DS-Signature = "sha256=" + hex(HMAC_SHA256(secret, timestamp + "." + body))
 */

var MAX_PER_RUN = 25;                    // messages per trigger run (Apps Script has a 6 min limit)
var MAX_PAYLOAD_BYTES = 35 * 1024 * 1024; // keep below MAIL_WEBHOOK_MAX_MB on the server
var PROCESSED_KEEP = 400;                // remembered message ids (script property size limit)

function setup() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('DS_WEBHOOK_URL') || !props.getProperty('DS_WEBHOOK_SECRET')) {
    throw new Error('Set DS_WEBHOOK_URL and DS_WEBHOOK_SECRET in Project Settings → Script properties first.');
  }
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processInbox') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processInbox').timeBased().everyMinutes(1).create();
  if (!props.getProperty('DS_SINCE')) props.setProperty('DS_SINCE', String(Date.now()));
  Logger.log('DriveSurfe forwarder installed.');
}

function processInbox() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // previous run still going
  try {
    var props = PropertiesService.getScriptProperties();
    var url = props.getProperty('DS_WEBHOOK_URL');
    var secret = props.getProperty('DS_WEBHOOK_SECRET');
    var query = props.getProperty('DS_SEARCH_QUERY') || 'in:inbox newer_than:2d';
    var since = Number(props.getProperty('DS_SINCE') || Date.now());
    var processed = JSON.parse(props.getProperty('DS_PROCESSED') || '[]');
    var seen = {};
    processed.forEach(function (id) { seen[id] = true; });

    var sent = 0;
    var threads = GmailApp.search(query, 0, 50);
    outer:
    for (var t = 0; t < threads.length; t++) {
      var messages = threads[t].getMessages();
      for (var m = 0; m < messages.length; m++) {
        var msg = messages[m];
        if (seen[msg.getId()] || msg.getDate().getTime() < since || msg.isInTrash()) continue;
        if (sent >= MAX_PER_RUN) break outer;
        sent++;

        var outcome = deliver(url, secret, buildPayload(threads[t], msg));
        if (outcome === 'auth') {
          Logger.log('Webhook rejected the signature — check DS_WEBHOOK_SECRET. Stopping.');
          break outer;
        }
        if (outcome === 'done') {
          processed.push(msg.getId());
          seen[msg.getId()] = true;
        }
        // 'retry' → left unmarked, picked up again next run
      }
    }

    props.setProperty('DS_PROCESSED', JSON.stringify(processed.slice(-PROCESSED_KEEP)));
  } finally {
    lock.releaseLock();
  }
}

function buildPayload(thread, msg) {
  var all = msg.getAttachments({ includeInlineImages: true, includeAttachments: true });
  var regular = {};
  msg.getAttachments({ includeInlineImages: false, includeAttachments: true }).forEach(function (a) {
    regular[a.getName() + '|' + a.getSize()] = true;
  });

  var labels = thread.getLabels().map(function (l) { return l.getName(); });
  if (msg.isInInbox()) labels.push('INBOX');
  if (msg.isStarred()) labels.push('STARRED');
  if (msg.isUnread()) labels.push('UNREAD');

  return {
    id: msg.getId(),
    thread_id: thread.getId(),
    from: msg.getFrom(),
    to: msg.getTo(),
    cc: msg.getCc(),
    subject: msg.getSubject(),
    date: msg.getDate().toISOString(),
    body_text: (msg.getPlainBody() || '').slice(0, 500000),
    labels: labels,
    attachments: all.map(function (a) {
      return {
        name: a.getName(),
        mime_type: a.getContentType(),
        inline: !regular[a.getName() + '|' + a.getSize()],
        content_base64: Utilities.base64Encode(a.getBytes()),
      };
    }),
  };
}

/** @return 'done' | 'retry' | 'auth' */
function deliver(url, secret, payload) {
  var body = JSON.stringify(payload);
  var bytes = Utilities.newBlob(body).getBytes(); // UTF-8 — exactly what gets signed
  if (bytes.length > MAX_PAYLOAD_BYTES) {
    Logger.log('Skipping ' + payload.id + ': payload too large (' + bytes.length + ' bytes)');
    return 'done';
  }

  var ts = String(Math.floor(Date.now() / 1000));
  var sig = Utilities.computeHmacSha256Signature(ts + '.' + body, secret, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); })
    .join('');

  var res;
  try {
    res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: bytes,
      headers: { 'X-DS-Timestamp': ts, 'X-DS-Signature': 'sha256=' + sig },
      muteHttpExceptions: true,
      followRedirects: false,
    });
  } catch (e) {
    Logger.log('Delivery of ' + payload.id + ' failed: ' + e);
    return 'retry';
  }

  var code = res.getResponseCode();
  if (code >= 200 && code < 300) return 'done';
  if (code === 401 || code === 404 || code === 429) return 'auth';
  // 400/413/415/422 won't succeed on retry; 409 = in progress / replay; 5xx = retry.
  if (code === 400 || code === 413 || code === 415 || code === 422) {
    Logger.log('Webhook refused ' + payload.id + ' (' + code + '): ' + res.getContentText().slice(0, 300));
    return 'done';
  }
  return 'retry';
}
