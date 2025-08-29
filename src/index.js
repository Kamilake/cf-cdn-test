// src/index.js
import encodeWebp, { init as initWebpEncWasm } from '@jsquash/webp/encode';
import decodeWebp, { init as initWebpDecWasm } from '@jsquash/webp/decode';
import resize, { initResize } from '@jsquash/resize';

// @Note, We need to manually import the WASM binaries below so that we can use them in the worker
// CF Workers do not support dynamic imports
// import JPEG_DEC_WASM from "../node_modules/@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm";
// import PNG_DEC_WASM from "../node_modules/@jsquash/png/codec/pkg/squoosh_png_bg.wasm";
import WEBP_DEC_WASM from "../node_modules/@jsquash/webp/codec/dec/webp_dec.wasm";
import WEBP_ENC_WASM from "../node_modules/@jsquash/webp/codec/enc/webp_enc.wasm";
import SQUOOSH_RESIZE_WASM from "../node_modules/@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm";

const TARGET = 160; // 목표
const MAX_IMAGE_SIZE = 1024 * 1024; // 1MB 제한
const MAX_DIMENSION = 2048; // 최대 이미지 크기 제한 (2048x2048)

export default {
  async fetch(request) {
    const startTime = performance.now();

    const url = new URL(request.url);
    const id = url.pathname.slice(1); // /{emojiId}

    // 기본 유효성 검사
    if (!id || id.length > 100) {
      return new Response('Invalid emoji ID', { status: 400 });
    }

    // 원본 가져오기 (Discord가 webp 리사이즈를 안해줘서 원본을 그대로 받음)
    const origin = new URL(`https://cdn.discordapp.com/emojis/${id}.webp?size=160&animated=true`);
    const upstream = await fetch(origin.toString());
    if (!upstream.ok) return new Response('upstream error', { status: 502 });
    // fetch 이후 순수 처리 시간 측정 시작
    const processingStartTime = performance.now();

    // Content-Length 확인으로 크기 제한
    const contentLength = upstream.headers.get('content-length');
    if (contentLength && parseInt(contentLength) > MAX_IMAGE_SIZE) {
      return new Response('Image too large', { status: 413 });
    }

    const buf = await upstream.arrayBuffer();
    // 실제 크기 확인
    if (buf.byteLength > MAX_IMAGE_SIZE) {
      return new Response('Image too large', { status: 413 });
    }

    const isAnimated = isAnimatedWebP(buf);
    console.log('Is animated WebP:', isAnimated);

    // 1) 애니메이티드 WebP면 공식 변환 API만 사용 (Cloudflare Image Resizing)
    if (isAnimated) {
      const r = await fetch(origin.toString(), {
        cf: {
          image: {
            width: TARGET,
            height: TARGET,
            fit: 'contain',
            format: 'webp',
            // animated: true 는 문서화된 옵션이 아니라도,
            // 애니메이션 입력은 그대로 animated webp/gif로 출력 가능 (공식 문서 참고)
            // 품질/노이즈는 필요에 맞게 조절
            quality: 80
          }
        }
      });
      // 그대로 전달 (헤더 정리)
      return new Response(r.body, {
        headers: {
          'content-type': 'image/webp',
          // 'cache-control': 'public, max-age=31536000, immutable'
          'cache-control': 'public, max-age=0'
        },
        status: r.status
      });
    }

    // 2) 정적 WebP: WASM으로 decode → 리사이즈(contain) → encode(webp)
    await initWebpDecWasm(WEBP_DEC_WASM);
    const src = await decodeWebp(buf); // ImageData {data, width, height}
    console.log('Decoded image size:', src.width, 'x', src.height);
    const { width, height } = src;

    // 이미지 크기 제한 확인
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      return new Response('Image dimensions too large', { status: 413 });
    }

    const { w, h } = contain(width, height, TARGET, TARGET);
    initResize(SQUOOSH_RESIZE_WASM);

    const resized = await resize(src, {
      width: w,
      height: h,
      method: 'lanczos3' // 품질↑. 속도가 더 중요하면 'triangle' 등으로 교체
      // method: 'triangle'
    });
    await initWebpEncWasm(WEBP_ENC_WASM);

    const out = await encodeWebp(resized, {
      quality: 70, // 작은 아이콘이면 70~90 사이 권장
      effort: 1    // 인코딩 속도/용량 트레이드오프 (낮을수록 빠름)
    });
    const totalEndTime = performance.now();
    console.log(`Total processing time: ${(totalEndTime - startTime)}ms`);
    console.log(`Pure processing time (excluding fetch): ${(totalEndTime - processingStartTime)}ms`);

    return new Response(out, {
      headers: {
        'content-type': 'image/webp',
        'cache-control': 'public, max-age=31536000, immutable'
      }
    });
  }
};

/** VP8X 헤더의 Animation 플래그(비트1=0x02) 검사로 초고속 판별 */
function isAnimatedWebP(arrayBuffer) {
  const u8 = new Uint8Array(arrayBuffer);
  if (u8.length < 16) return false;

  // 'RIFF' .... 'WEBP'
  if (!(u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46)) return false;
  if (!(u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50)) return false;

  // chunk 스캔 (최대 10개 청크만 확인하여 무한루프 방지)
  let i = 12;
  let chunkCount = 0;
  const MAX_CHUNKS = 10;

  while (i + 8 <= u8.length && chunkCount < MAX_CHUNKS) {
    const type = String.fromCharCode(u8[i], u8[i + 1], u8[i + 2], u8[i + 3]);
    const size = u8[i + 4] | (u8[i + 5] << 8) | (u8[i + 6] << 16) | (u8[i + 7] << 24);

    // 비정상적인 청크 크기 검사
    if (size < 0 || size > arrayBuffer.byteLength) {
      console.warn('Invalid chunk size detected');
      return false;
    }

    if (type === 'VP8X') {
      const flags = u8[i + 8];           // VP8X payload 첫 바이트
      return (flags & 0x02) !== 0;        // bit1 == Animation
    }

    // 다음 청크(짝수 패딩)
    i += 8 + size + (size & 1);
    chunkCount++;
  }
  return false;
}

/** contain 스케일 (여백 없이 가장 긴 변을 TARGET에 맞춤) */
function contain(w, h, maxW, maxH) {
  const s = Math.min(maxW / w, maxH / h);
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}