<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import Sheet from './Sheet.svelte'
  import { toExchangeCode, decodeFrame } from '../lib/qr-scan'

  let { onclose, ondetect }: { onclose: () => void; ondetect: (code: string) => void } = $props()

  // Minimal shape of the native detector we use — the DOM lib doesn't ship a
  // BarcodeDetector type, and declaring only what we touch keeps this off `any`.
  interface DetectedBarcode {
    rawValue: string
  }
  interface BarcodeDetectorLike {
    detect(source: CanvasImageSource): Promise<DetectedBarcode[]>
  }

  let video = $state<HTMLVideoElement>()
  let error = $state('')
  let stream: MediaStream | null = null
  let raf = 0
  let detector: BarcodeDetectorLike | null = null
  let canvas: HTMLCanvasElement | null = null

  async function start() {
    // getUserMedia is absent in an insecure context (non-HTTPS/localhost) and
    // on devices with no camera API — either way, fall back to the paste box.
    if (!navigator.mediaDevices?.getUserMedia) {
      error = "This browser can't open the camera here. Paste their code instead."
      return
    }
    try {
      // Rear camera by preference; falls back to any camera on desktops.
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      })
    } catch {
      error = 'Camera access was blocked or unavailable. Paste their code instead.'
      return
    }
    if (video) {
      video.srcObject = stream
      // Some engines reject play() on an unmounted element mid-teardown; the
      // scan loop tolerates a not-yet-playing video, so ignore it.
      await video.play().catch(() => {})
    }
    // Prefer the native decoder; iOS Safari lacks it, so fall back to jsQR.
    const Ctor = (
      window as unknown as {
        BarcodeDetector?: new (opts: { formats: string[] }) => BarcodeDetectorLike
      }
    ).BarcodeDetector
    if (Ctor) {
      try {
        detector = new Ctor({ formats: ['qr_code'] })
      } catch {
        detector = null
      }
    }
    raf = requestAnimationFrame(tick)
  }

  async function tick() {
    if (!video || video.readyState < 2) {
      raf = requestAnimationFrame(tick)
      return
    }
    let text: string | null = null
    try {
      if (detector) {
        text = (await detector.detect(video))[0]?.rawValue ?? null
      } else {
        canvas ??= document.createElement('canvas')
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (ctx) {
          ctx.drawImage(video, 0, 0)
          const frame = ctx.getImageData(0, 0, canvas.width, canvas.height)
          text = await decodeFrame(frame.data, frame.width, frame.height)
        }
      }
    } catch {
      // A transient decode error on one frame is not fatal — keep scanning.
    }
    const code = toExchangeCode(text)
    if (code) {
      stop()
      ondetect(code)
      return
    }
    raf = requestAnimationFrame(tick)
  }

  // Fully release the camera: cancel the loop and stop every track, so the
  // capture light goes out the instant the scanner closes or unmounts.
  function stop() {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    stream?.getTracks().forEach((track) => track.stop())
    stream = null
  }

  function close() {
    stop()
    onclose()
  }

  onMount(start)
  onDestroy(stop)
</script>

<Sheet onclose={close}>
  <h2>Scan their code</h2>
  {#if error}
    <p class="error" data-testid="scanner-error">{error}</p>
    <button class="primary" onclick={onclose} data-testid="scanner-fallback">Paste instead</button>
  {:else}
    <div class="viewport">
      <!-- svelte-ignore a11y_media_has_caption -->
      <video bind:this={video} playsinline muted data-testid="scanner-video"></video>
    </div>
    <p class="muted">
      Point the camera at the other person's QR. The image is read on this device only — no frames
      leave your phone.
    </p>
    <button onclick={close} data-testid="scanner-cancel">Cancel</button>
  {/if}
</Sheet>

<style>
  h2 {
    margin: 0 0 var(--space-2);
  }

  .viewport {
    aspect-ratio: 1;
    max-width: 20rem;
    margin: 0 auto var(--space-3);
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: #000;
  }

  video {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
</style>
