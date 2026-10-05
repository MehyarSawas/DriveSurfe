import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { MailLogEntry, MailMeta, MailProcessor, ProcessorResult, TestEmail } from '../models/mail-processor.model';

interface ApiResponse<T> {
  data: T;
}

/** Settings API for inbound-email processors (`/api/mail/*`). */
@Injectable({ providedIn: 'root' })
export class MailProcessorService {
  private http = inject(HttpClient);

  async getMeta(): Promise<MailMeta> {
    return (await firstValueFrom(this.http.get<ApiResponse<MailMeta>>('/api/mail/meta'))).data;
  }

  async list(): Promise<MailProcessor[]> {
    return (await firstValueFrom(this.http.get<ApiResponse<MailProcessor[]>>('/api/mail/processors'))).data;
  }

  async save(p: MailProcessor): Promise<MailProcessor> {
    const req = p.id
      ? this.http.put<ApiResponse<MailProcessor>>(`/api/mail/processors/${p.id}`, p)
      : this.http.post<ApiResponse<MailProcessor>>('/api/mail/processors', p);
    return (await firstValueFrom(req)).data;
  }

  async delete(id: string): Promise<void> {
    await firstValueFrom(this.http.delete(`/api/mail/processors/${id}`));
  }

  async reorder(ids: string[]): Promise<MailProcessor[]> {
    return (await firstValueFrom(this.http.post<ApiResponse<MailProcessor[]>>('/api/mail/processors/reorder', { ids }))).data;
  }

  /** Dry run: which processors match the sample email and what they would do. No uploads. */
  async test(email: TestEmail, processor?: MailProcessor): Promise<ProcessorResult[]> {
    const body = { email, ...(processor ? { processor } : {}) };
    return (await firstValueFrom(this.http.post<ApiResponse<ProcessorResult[]>>('/api/mail/processors/test', body))).data;
  }

  async getLog(): Promise<MailLogEntry[]> {
    return (await firstValueFrom(this.http.get<ApiResponse<MailLogEntry[]>>('/api/mail/log'))).data;
  }

  async clearLog(): Promise<void> {
    await firstValueFrom(this.http.delete('/api/mail/log'));
  }
}
