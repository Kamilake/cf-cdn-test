// src/index.js
import encodeWebp, { init as initWebpEncWasm } from '@jsquash/webp/encode';
import decodeWebp, { init as initWebpDecWasm, decodeAnimated } from '@jsquash/webp/decode';
import resize, { initResize } from '@jsquash/resize';

import * as gifski from 'gifski-wasm';

// @Note, We need to manually import the WASM binaries below so that we can use them in the worker
// CF Workers do not support dynamic imports
// import JPEG_DEC_WASM from "../node_modules/@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm";
// import PNG_DEC_WASM from "../node_modules/@jsquash/png/codec/pkg/squoosh_png_bg.wasm";
import WEBP_DEC_WASM from "../node_modules/@jsquash/webp/codec/dec/webp_dec.wasm";
import WEBP_ENC_WASM from "../node_modules/@jsquash/webp/codec/enc/webp_enc.wasm";
import SQUOOSH_RESIZE_WASM from "../node_modules/@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm";
import GIFSKI_WASM from '../node_modules/gifski-wasm/pkg/gifski_wasm_bg.wasm';

const TARGET = 160; // 목표 50x50 'contain'
const MAX_IMAGE_SIZE = 2 * 1024 * 1024; // 2MB 제한
const MAX_DIMENSION = 2048; // 최대 이미지 크기 제한 (2048x2048)
const PROCESSING_TIMEOUT = 30000; // 30초 타임아웃

export default {
  async fetch(request) {
    // 전체 요청에 대한 타임아웃 설정
    return Promise.race([
      processRequest(request),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Request timeout')), PROCESSING_TIMEOUT)
      )
    ]).catch(error => {
      console.error('Request failed:', error);

      // 상세 오류 정보 반환
      if (error.message === 'Request timeout') {
        return new Response('Request processing timeout', {
          status: 408,
          headers: { 'content-type': 'text/plain' }
        });
      }

      // 기타 오류의 경우 상세 메시지 포함
      return new Response(`Processing error: ${error.message}`, {
        status: 500,
        headers: { 'content-type': 'text/plain' }
      });
    });
  }
};

async function processRequest(request) {
  const startTime = performance.now();

  const url = new URL(request.url);
  const id = url.pathname.slice(1); // /{emojiId}

  // 기본 유효성 검사
  if (!id || id.length > 100) {
    return new Response('Invalid emoji ID', { status: 400 });
  }

  // 원본 가져오기 (Discord가 webp 리사이즈를 안해줘서 원본을 그대로 받음)
  const fetchStartTime = performance.now();
  const origin = new URL(`https://cdn.discordapp.com/emojis/${id}.webp?size=160&animated=true`);
  const upstream = await fetch(origin.toString());
  if (!upstream.ok) return new Response('upstream error', { status: 502 });
  const fetchEndTime = performance.now();
  console.log(`Upstream fetch time: ${(fetchEndTime - fetchStartTime).toFixed(1)}ms`);

  // fetch 이후 순수 처리 시간 측정 시작
  const processingStartTime = performance.now();

  console.log('Upstream content-length:', upstream.headers.get('content-length'));

  // Content-Length 확인으로 크기 제한
  const contentLength = upstream.headers.get('content-length');
  if (contentLength && parseInt(contentLength) > MAX_IMAGE_SIZE) {
    return new Response('Image too large', { status: 413 });
  }

  const bufferStartTime = performance.now();
  const buf = await upstream.arrayBuffer();
  const bufferEndTime = performance.now();
  console.log(`Buffer read time: ${(bufferEndTime - bufferStartTime).toFixed(1)}ms`);

  console.log('Upstream actual size:', buf.byteLength, 'bytes');

  // 실제 크기 확인
  if (buf.byteLength > MAX_IMAGE_SIZE) {
    return new Response('Image too large', { status: 413 });
  }

  const animationCheckStartTime = performance.now();
  const isAnimated = isAnimatedWebP(buf);
  const animationCheckEndTime = performance.now();
  console.log(`Animation check time: ${(animationCheckEndTime - animationCheckStartTime).toFixed(1)}ms`);
  console.log('Is animated WebP:', isAnimated);

  // 1) 애니메이티드 WebP면 공식 변환 API만 사용 (Cloudflare Image Resizing)
  if (isAnimated && false) {
    const cfResizeStartTime = performance.now();
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


    const cfResizeEndTime = performance.now();
    console.log(`Cloudflare resize time: ${(cfResizeEndTime - cfResizeStartTime).toFixed(1)}ms`);

    const totalEndTime = performance.now();
    console.log(`Total processing time: ${(totalEndTime - startTime).toFixed(1)}ms`);
    console.log(`Pure processing time (excluding fetch): ${(totalEndTime - processingStartTime).toFixed(1)}ms`);

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
  console.log('Initializing WebP decoder...');
  const initDecStartTime = performance.now();
  await initWebpDecWasm(WEBP_DEC_WASM);
  const initDecEndTime = performance.now();
  console.log(`WebP decoder init time: ${(initDecEndTime - initDecStartTime).toFixed(1)}ms`);

  console.log('Decoding WebP image...');
  const decodeStartTime = performance.now();
  let src;
  if (isAnimated) {
    src = await decodeAnimated(buf);
    // decodeAnimated
    const decodeEndTime = performance.now();
    console.log(`WebP decode time: ${(decodeEndTime - decodeStartTime).toFixed(1)}ms`);
    const { width, height } = src[0].imageData;
    console.log('Decoded image size:', width, 'x', height);
    // 이미지 크기 제한 확인
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      return new Response('Image dimensions too large', { status: 413 });
    }

    const { w, h } = contain(width, height, TARGET, TARGET);
    console.log(`Initializing Resize module...`);
    const initResizeStartTime = performance.now();
    initResize(SQUOOSH_RESIZE_WASM);
    const initResizeEndTime = performance.now();
    console.log(`Resize module init time: ${(initResizeEndTime - initResizeStartTime).toFixed(1)}ms`);
    console.log(`Resizing to ${w}x${h}...`);
    const resizeStartTime = performance.now();
    const resized = await resize(src[0].imageData, {
      width: w,
      height: h,
      method: 'lanczos3' // 품질↑. 속도가 더 중요하면 'triangle' 등으로 교체
      // method: 'triangle'
    });

    const resizeEndTime = performance.now();
    console.log(`Resize processing time: ${(resizeEndTime - resizeStartTime).toFixed(1)}ms`);

    console.log('Initializing WebP encoder...');
    const initEncStartTime = performance.now();
    await initWebpEncWasm(WEBP_ENC_WASM);
    const initEncEndTime = performance.now();
    console.log(`WebP encoder init time: ${(initEncEndTime - initEncStartTime).toFixed(1)}ms`);

    console.log('Encoding to WebP...');
    const encodeStartTime = performance.now();
    const out = await encodeWebp(resized, {
      quality: 80, // 작은 아이콘이면 70~90 사이 권장
      effort: 4    // 인코딩 속도/용량 트레이드오프 (낮을수록 빠름)
    });
    const encodeEndTime = performance.now();
    console.log(`WebP encode time: ${(encodeEndTime - encodeStartTime).toFixed(1)}ms`);
    console.log('Encoding complete, output size:', out.byteLength, 'bytes');

    const totalEndTime = performance.now();
    console.log(`Total processing time: ${(totalEndTime - startTime).toFixed(1)}ms`);
    console.log(`Pure processing time (excluding fetch): ${(totalEndTime - processingStartTime).toFixed(1)}ms`);

    return new Response(out, {
      headers: {
        'content-type': 'image/webp',
        'cache-control': 'public, max-age=31536000, immutable'
      }
    });














  }
  else {
    src = await decodeWebp(buf); // ImageData {data, width, height}
    // decodeAnimated
    const decodeEndTime = performance.now();
    console.log(`WebP decode time: ${(decodeEndTime - decodeStartTime).toFixed(1)}ms`);
    const { width, height } = src;
    console.log('Decoded image size:', width, 'x', height);
    // 이미지 크기 제한 확인
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      return new Response('Image dimensions too large', { status: 413 });
    }
    const { w, h } = contain(width, height, TARGET, TARGET);
    console.log(`Initializing Resize module...`);
    const initResizeStartTime = performance.now();
    initResize(SQUOOSH_RESIZE_WASM);
    const initResizeEndTime = performance.now();
    console.log(`Resize module init time: ${(initResizeEndTime - initResizeStartTime).toFixed(1)}ms`);
    console.log(`Resizing to ${w}x${h}...`);
    const resizeStartTime = performance.now();
    const resized = await resize(src, {
      width: w,
      height: h,
      method: 'lanczos3' // 품질↑. 속도가 더 중요하면 'triangle' 등으로 교체
      // method: 'triangle'
    });

    const resizeEndTime = performance.now();
    console.log(`Resize processing time: ${(resizeEndTime - resizeStartTime).toFixed(1)}ms`);

    console.log('Initializing WebP encoder...');
    const initEncStartTime = performance.now();
    await initWebpEncWasm(WEBP_ENC_WASM);
    const initEncEndTime = performance.now();
    console.log(`WebP encoder init time: ${(initEncEndTime - initEncStartTime).toFixed(1)}ms`);

    console.log('Encoding to WebP...');
    const encodeStartTime = performance.now();
    const out = await encodeWebp(resized, {
      quality: 80, // 작은 아이콘이면 70~90 사이 권장
      effort: 4    // 인코딩 속도/용량 트레이드오프 (낮을수록 빠름)
    });
    const encodeEndTime = performance.now();
    console.log(`WebP encode time: ${(encodeEndTime - encodeStartTime).toFixed(1)}ms`);
    console.log('Encoding complete, output size:', out.byteLength, 'bytes');

    const totalEndTime = performance.now();
    console.log(`Total processing time: ${(totalEndTime - startTime).toFixed(1)}ms`);
    console.log(`Pure processing time (excluding fetch): ${(totalEndTime - processingStartTime).toFixed(1)}ms`);

    return new Response(out, {
      headers: {
        'content-type': 'image/webp',
        'cache-control': 'public, max-age=31536000, immutable'
      }
    });

  }







}



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


const decodeImage = async (buffer, format) => {
  if (format === 'webp') {
    await initWebpDecWasm(WEBP_DEC_WASM);
    return decodeWebp(buffer);
  } else if (format === 'jpeg' || format === 'jpg') {
    // @Note, we need to manually initialise the wasm module here from wasm import at top of file
    await initJpegWasm(JPEG_DEC_WASM);
    return decodeJpeg(buffer);
  } else if (format === 'png') {
    // @Note, we need to manually initialise the wasm module here from wasm import at top of file
    await initPngWasm(PNG_DEC_WASM);
    return decodePng(buffer);
  }

  throw new Error(`Unsupported format: ${format}`);
}
