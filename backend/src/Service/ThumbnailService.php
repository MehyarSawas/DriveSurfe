<?php declare(strict_types=1);

namespace DriveSurfe\Service;

final class ThumbnailService
{
    public function generateFromHeic(string $inputPath, string $outputPath, int $width = 400): bool
    {
        $input = escapeshellarg($inputPath);
        $output = escapeshellarg($outputPath);
        $cmd = "convert {$input}[0] -thumbnail {$width}x{$width}\\> -auto-orient {$output} 2>&1";
        exec($cmd, $output_lines, $return);
        return $return === 0;
    }

    public function generateFromVideo(string $inputPath, string $outputPath, int $width = 400): bool
    {
        $input = escapeshellarg($inputPath);
        $output = escapeshellarg($outputPath);
        // Extract frame at 1 second using ffmpeg if available, else ImageMagick
        $cmd = "ffmpeg -ss 00:00:01 -i {$input} -vframes 1 -vf scale={$width}:-1 {$output} 2>&1";
        exec($cmd, $out, $return);
        if ($return !== 0) {
            // Fallback: try ImageMagick for video
            $cmd = "convert {$input}[0] -thumbnail {$width}x{$width}\\> {$output} 2>&1";
            exec($cmd, $out, $return);
        }
        return $return === 0;
    }

    public function isHeic(string $filename): bool
    {
        return in_array(strtolower(pathinfo($filename, PATHINFO_EXTENSION)), ['heic', 'heif'], true);
    }

    public function isVideo(string $filename): bool
    {
        return in_array(strtolower(pathinfo($filename, PATHINFO_EXTENSION)), ['mp4', 'mov', 'm4v', 'avi', 'mkv'], true);
    }
}
