import { getEvents, getSegment } from './replay.service';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// ── Constants ──────────────────────────────────────────────────────────────

const VIDEO_OUTPUT_DIR = '/app/uploads/videos';
const CHROMIUM_PATH = '/usr/bin/chromium-browser';
const SCREENSHOT_INTERVAL_MS = 33; // ~30fps
const FPS = 30;

const RRWEB_PLAYER_JS = 'https://cdn.jsdelivr.net/npm/rrweb-player@latest/dist/index.js';
const RRWEB_PLAYER_CSS = 'https://cdn.jsdelivr.net/npm/rrweb-player@latest/dist/style.css';

// ── Types ──────────────────────────────────────────────────────────────────

interface RenderResult {
  success: boolean;
  filePath?: string;
  error?: string;
  durationMs?: number;
}

// ── HTML Template ──────────────────────────────────────────────────────────

function buildPlayerHTML(
  events: any[],
  viewportWidth: number,
  viewportHeight: number
): string {
  // Extract click events for marker overlay.
  // Clicks: type 3 (IncrementalSnapshot), data.source 2 (MouseInteraction), data.type 2 (Click)
  const clicks: { timestamp: number; x: number; y: number }[] = [];
  for (const ev of events) {
    if (ev.type === 3 && ev.data?.source === 2 && ev.data?.type === 2) {
      clicks.push({ timestamp: ev.timestamp, x: ev.data.x, y: ev.data.y });
    }
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>XRay Replay Renderer</title>
  <link rel="stylesheet" href="${RRWEB_PLAYER_CSS}">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: ${viewportWidth}px;
      height: ${viewportHeight}px;
      overflow: hidden;
      background: #fff;
    }
    #player-container {
      width: ${viewportWidth}px;
      height: ${viewportHeight}px;
      position: relative;
      overflow: hidden;
    }
    /* Override rrweb-player wrapper styles to fill viewport */
    .rr-player {
      width: ${viewportWidth}px !important;
      height: ${viewportHeight}px !important;
    }
    .rr-player__frame {
      width: ${viewportWidth}px !important;
      height: ${viewportHeight}px !important;
    }
    /* Hide the rrweb-player controls bar */
    .rr-controller { display: none !important; }
    .rr-timeline { display: none !important; }
    .rr-player-controller { display: none !important; }

    /* Click marker animation */
    .click-marker {
      position: absolute;
      width: 30px;
      height: 30px;
      border-radius: 50%;
      border: 3px solid #e74c3c;
      background: rgba(231, 76, 60, 0.3);
      pointer-events: none;
      z-index: 999999;
      animation: click-ripple 0.6s ease-out forwards;
      transform: translate(-50%, -50%);
    }
    @keyframes click-ripple {
      0% { transform: translate(-50%, -50%) scale(0.3); opacity: 1; }
      50% { transform: translate(-50%, -50%) scale(1); opacity: 0.7; }
      100% { transform: translate(-50%, -50%) scale(1.5); opacity: 0; }
    }
  </style>
</head>
<body>
  <div id="player-container"></div>
  <script src="${RRWEB_PLAYER_JS}"></script>
  <script>
    window.__REPLAY_DONE = false;
    window.__EVENTS = ${JSON.stringify(events)};
    window.__CLICKS = ${JSON.stringify(clicks)};

    (function() {
      const events = window.__EVENTS;
      if (!events || events.length === 0) {
        console.error('No events to replay');
        window.__REPLAY_DONE = true;
        return;
      }

      const container = document.getElementById('player-container');

      // Create rrweb player
      const player = new rrwebPlayer({
        target: container,
        props: {
          events: events,
          autoPlay: true,
          speed: 1,
          showController: false,
          width: ${viewportWidth},
          height: ${viewportHeight},
          skipInactive: true,
          mouseTail: true,
        },
      });

      // Calculate session timeline
      const startTime = events[0].timestamp;
      const endTime = events[events.length - 1].timestamp;
      const totalDuration = endTime - startTime;

      // Schedule click markers
      const clickEvents = window.__CLICKS;
      for (const click of clickEvents) {
        const delay = click.timestamp - startTime;
        if (delay >= 0 && delay <= totalDuration) {
          setTimeout(() => {
            const marker = document.createElement('div');
            marker.className = 'click-marker';
            marker.style.left = click.x + 'px';
            marker.style.top = click.y + 'px';
            container.appendChild(marker);
            // Remove marker after animation completes
            setTimeout(() => {
              if (marker.parentNode) marker.parentNode.removeChild(marker);
            }, 700);
          }, delay);
        }
      }

      // Signal replay completion
      // Add a small buffer after the last event for the final frame
      const completionDelay = totalDuration + 1000;
      setTimeout(() => {
        console.log('Replay complete');
        window.__REPLAY_DONE = true;
      }, completionDelay);

      // Safety timeout: if replay doesn't complete in 5 minutes, force done
      setTimeout(() => {
        if (!window.__REPLAY_DONE) {
          console.warn('Replay safety timeout reached');
          window.__REPLAY_DONE = true;
        }
      }, 300000);
    })();
  </script>
</body>
</html>`;
}

// ── Utility: ensure output directory exists ────────────────────────────────

function ensureVideoDir(): void {
  if (!fs.existsSync(VIDEO_OUTPUT_DIR)) {
    fs.mkdirSync(VIDEO_OUTPUT_DIR, { recursive: true });
  }
}

// ── Utility: check binary availability ─────────────────────────────────────

function checkBinary(binaryPath: string): boolean {
  try {
    fs.accessSync(binaryPath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function checkFfmpeg(): boolean {
  try {
    const result = require('child_process').execSync('which ffmpeg', { encoding: 'utf-8' });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

// ── Main Render Function ───────────────────────────────────────────────────

export async function renderSegmentVideo(segmentId: string): Promise<RenderResult> {
  const startTime = Date.now();
  console.log(`[video-render] Starting render for segment ${segmentId}`);

  // Pre-flight checks
  let puppeteer: any;
  try {
    puppeteer = require('puppeteer-core');
  } catch (err) {
    console.error('[video-render] puppeteer-core is not installed');
    return {
      success: false,
      error: 'puppeteer-core is not installed. Install it with: npm install puppeteer-core',
    };
  }

  if (!checkBinary(CHROMIUM_PATH)) {
    console.error(`[video-render] Chromium not found at ${CHROMIUM_PATH}`);
    return {
      success: false,
      error: `Chromium not found at ${CHROMIUM_PATH}. Install chromium-browser.`,
    };
  }

  if (!checkFfmpeg()) {
    console.error('[video-render] ffmpeg not found in PATH');
    return {
      success: false,
      error: 'ffmpeg not found in PATH. Install ffmpeg.',
    };
  }

  // Fetch segment data
  let events: any[];
  let segment: any;
  try {
    [events, segment] = await Promise.all([
      getEvents(segmentId),
      getSegment(segmentId),
    ]);
  } catch (err: any) {
    console.error(`[video-render] Failed to fetch segment data: ${err.message}`);
    return { success: false, error: `Failed to fetch segment data: ${err.message}` };
  }

  if (!events || events.length === 0) {
    console.error('[video-render] No events found for segment');
    return { success: false, error: 'No events found for this segment' };
  }

  const viewportWidth = segment.viewport_width || 1280;
  const viewportHeight = segment.viewport_height || 720;

  console.log(`[video-render] Events: ${events.length}, Viewport: ${viewportWidth}x${viewportHeight}`);

  // Calculate replay duration from event timestamps
  const firstTimestamp = events[0].timestamp;
  const lastTimestamp = events[events.length - 1].timestamp;
  const replayDurationMs = lastTimestamp - firstTimestamp;
  console.log(`[video-render] Replay duration: ${(replayDurationMs / 1000).toFixed(1)}s`);

  // Prepare output
  ensureVideoDir();
  const outputPath = path.join(VIDEO_OUTPUT_DIR, `segment-${segmentId}.mp4`);
  const html = buildPlayerHTML(events, viewportWidth, viewportHeight);

  let browser: any = null;

  try {
    // Launch browser
    console.log('[video-render] Launching Puppeteer...');
    browser = await puppeteer.launch({
      executablePath: CHROMIUM_PATH,
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        `--window-size=${viewportWidth},${viewportHeight}`,
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: viewportWidth, height: viewportHeight });

    // Load the replay HTML
    console.log('[video-render] Loading replay page...');
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });

    // Give the player a moment to initialize
    await page.waitForFunction('typeof rrwebPlayer !== "undefined" || document.querySelector(".rr-player")', {
      timeout: 10000,
    }).catch(() => {
      console.log('[video-render] Player element check timed out, proceeding anyway...');
    });

    // Small initial delay to ensure first frame renders
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Start screenshot capture + ffmpeg encoding
    console.log('[video-render] Starting screenshot capture at 30fps...');
    const videoResult = await captureWithScreenshots(
      page,
      outputPath,
      viewportWidth,
      viewportHeight,
      replayDurationMs
    );

    if (!videoResult.success) {
      return videoResult;
    }

    const elapsed = Date.now() - startTime;
    console.log(`[video-render] Render complete in ${(elapsed / 1000).toFixed(1)}s -> ${outputPath}`);

    return {
      success: true,
      filePath: outputPath,
      durationMs: replayDurationMs,
    };
  } catch (err: any) {
    console.error(`[video-render] Render failed: ${err.message}`);
    return { success: false, error: `Render failed: ${err.message}` };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Ignore close errors
      }
    }
  }
}

// ── Screenshot + ffmpeg Approach ───────────────────────────────────────────

async function captureWithScreenshots(
  page: any,
  outputPath: string,
  width: number,
  height: number,
  replayDurationMs: number
): Promise<RenderResult> {
  return new Promise<RenderResult>(async (resolve) => {
    let ffmpegProcess: ChildProcess | null = null;
    let captureInterval: ReturnType<typeof setInterval> | null = null;
    let resolved = false;

    function finish(result: RenderResult) {
      if (resolved) return;
      resolved = true;
      if (captureInterval) {
        clearInterval(captureInterval);
        captureInterval = null;
      }
      resolve(result);
    }

    try {
      // Start ffmpeg process that reads raw PNG frames from stdin
      ffmpegProcess = spawn('ffmpeg', [
        '-y',                         // Overwrite output
        '-f', 'image2pipe',           // Input is piped images
        '-framerate', String(FPS),    // Input framerate
        '-i', '-',                    // Read from stdin
        '-c:v', 'libx264',           // H.264 codec
        '-pix_fmt', 'yuv420p',       // Pixel format for compatibility
        '-preset', 'fast',           // Encoding speed/quality tradeoff
        '-crf', '23',                // Constant rate factor (quality)
        '-movflags', '+faststart',   // Enable streaming playback
        '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
        outputPath,
      ]);

      const ffmpegStderr: string[] = [];

      ffmpegProcess.stderr?.on('data', (data: Buffer) => {
        ffmpegStderr.push(data.toString());
      });

      ffmpegProcess.on('error', (err) => {
        console.error(`[video-render] ffmpeg process error: ${err.message}`);
        finish({ success: false, error: `ffmpeg error: ${err.message}` });
      });

      ffmpegProcess.on('close', (code) => {
        if (code !== 0 && !resolved) {
          const errOutput = ffmpegStderr.slice(-5).join('');
          console.error(`[video-render] ffmpeg exited with code ${code}: ${errOutput}`);
          finish({ success: false, error: `ffmpeg exited with code ${code}` });
        } else if (!resolved) {
          finish({ success: true, filePath: outputPath });
        }
      });

      // Capture screenshots in a loop
      let frameCount = 0;
      let captureStartTime = Date.now();
      // Add a buffer for the post-replay completion signal and final frames
      const maxCaptureDurationMs = replayDurationMs + 2000;
      let isCapturing = true;

      const captureFrame = async () => {
        if (!isCapturing || resolved) return;

        const elapsed = Date.now() - captureStartTime;

        // Check if replay is done or we've exceeded max duration
        const replayDone = await page.evaluate(() => (window as any).__REPLAY_DONE).catch(() => false);

        if (replayDone || elapsed >= maxCaptureDurationMs) {
          console.log(`[video-render] Capture ending. Frames: ${frameCount}, Elapsed: ${(elapsed / 1000).toFixed(1)}s, Replay done: ${replayDone}`);
          isCapturing = false;

          if (captureInterval) {
            clearInterval(captureInterval);
            captureInterval = null;
          }

          // Close ffmpeg stdin to signal end of input
          if (ffmpegProcess && ffmpegProcess.stdin) {
            ffmpegProcess.stdin.end();
          }
          return;
        }

        try {
          const screenshot = await page.screenshot({
            type: 'png',
            clip: { x: 0, y: 0, width, height },
          });

          if (ffmpegProcess && ffmpegProcess.stdin && !ffmpegProcess.stdin.destroyed) {
            const canWrite = ffmpegProcess.stdin.write(screenshot);
            if (!canWrite) {
              // Wait for drain before continuing
              await new Promise<void>((r) => ffmpegProcess!.stdin!.once('drain', r));
            }
          }

          frameCount++;

          if (frameCount % (FPS * 5) === 0) {
            console.log(`[video-render] Captured ${frameCount} frames (${(elapsed / 1000).toFixed(1)}s)`);
          }
        } catch (err: any) {
          // Screenshot can fail if page is navigating; skip the frame
          if (!err.message?.includes('Target closed') && !err.message?.includes('Session closed')) {
            console.warn(`[video-render] Screenshot error (frame ${frameCount}): ${err.message}`);
          }
        }
      };

      // Use setInterval for frame capture timing
      // The interval target is SCREENSHOT_INTERVAL_MS but actual timing depends on screenshot speed
      captureInterval = setInterval(captureFrame, SCREENSHOT_INTERVAL_MS);

      // Also capture the first frame immediately
      await captureFrame();

    } catch (err: any) {
      console.error(`[video-render] Screenshot capture error: ${err.message}`);

      // Clean up ffmpeg if it's still running
      if (ffmpegProcess && !ffmpegProcess.killed) {
        ffmpegProcess.kill('SIGTERM');
      }

      finish({ success: false, error: `Screenshot capture error: ${err.message}` });
    }
  });
}

// ── Get Video Path ─────────────────────────────────────────────────────────

export function getVideoPath(segmentId: string): string | null {
  const filePath = path.join(VIDEO_OUTPUT_DIR, `segment-${segmentId}.mp4`);
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return filePath;
  } catch {
    return null;
  }
}

// ── Cleanup Old Videos ─────────────────────────────────────────────────────

export async function cleanupOldVideos(maxAgeHours: number): Promise<{ deleted: number; errors: number }> {
  console.log(`[video-render] Cleaning up videos older than ${maxAgeHours} hours`);

  let deleted = 0;
  let errors = 0;

  if (!fs.existsSync(VIDEO_OUTPUT_DIR)) {
    console.log('[video-render] Video directory does not exist, nothing to clean');
    return { deleted: 0, errors: 0 };
  }

  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  const now = Date.now();

  try {
    const files = fs.readdirSync(VIDEO_OUTPUT_DIR);

    for (const file of files) {
      if (!file.endsWith('.mp4')) continue;

      const filePath = path.join(VIDEO_OUTPUT_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        const ageMs = now - stat.mtimeMs;

        if (ageMs > maxAgeMs) {
          fs.unlinkSync(filePath);
          deleted++;
          console.log(`[video-render] Deleted old video: ${file} (age: ${(ageMs / 3600000).toFixed(1)}h)`);
        }
      } catch (err: any) {
        errors++;
        console.error(`[video-render] Error processing ${file}: ${err.message}`);
      }
    }
  } catch (err: any) {
    console.error(`[video-render] Error reading video directory: ${err.message}`);
    errors++;
  }

  console.log(`[video-render] Cleanup complete. Deleted: ${deleted}, Errors: ${errors}`);
  return { deleted, errors };
}
