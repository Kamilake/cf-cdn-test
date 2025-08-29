// src/index.js
import { decode as decodeWebP, encode as encodeWebP } from '@jsquash/webp';
import resize from '@jsquash/resize';

const TARGET = 50; // 목표 50x50 'contain'

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const id = url.pathname.slice(1); // /{emojiId}

    // 원본 가져오기 (Discord가 webp 리사이즈를 안해줘서 원본을 그대로 받음)
    const origin = new URL(`https://cdn.discordapp.com/emojis/${id}.webp`);
    const upstream = await fetch(origin.toString());
    if (!upstream.ok) return new Response('upstream error', { status: 502 });

    const buf = await upstream.arrayBuffer();

    // 1) 애니메이티드 WebP면 공식 변환 API만 사용 (Cloudflare Image Resizing)
    if (isAnimatedWebP(buf)) {
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
          'cache-control': 'public, max-age=31536000, immutable'
        },
        status: r.status
      });
    }

    // 2) 정적 WebP: WASM으로 decode → 리사이즈(contain) → encode(webp)
    const src = await decodeWebP(buf); // ImageData {data, width, height}
    const { width, height } = src;
    const { w, h } = contain(width, height, TARGET, TARGET);

    const resized = await resize(src, {
      width: w,
      height: h,
      method: 'lanczos3' // 품질↑. 속도가 더 중요하면 'triangle' 등으로 교체
    });

    const out = await encodeWebP(resized, {
      quality: 80, // 작은 아이콘이면 70~90 사이 권장
      effort: 4    // 인코딩 속도/용량 트레이드오프 (낮을수록 빠름)
    });

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

  // chunk 스캔
  let i = 12;
  while (i + 8 <= u8.length) {
    const type = String.fromCharCode(u8[i], u8[i + 1], u8[i + 2], u8[i + 3]);
    const size = u8[i + 4] | (u8[i + 5] << 8) | (u8[i + 6] << 16) | (u8[i + 7] << 24);
    if (type === 'VP8X') {
      const flags = u8[i + 8];           // VP8X payload 첫 바이트
      return (flags & 0x02) !== 0;        // bit1 == Animation
    }
    // 다음 청크(짝수 패딩)
    i += 8 + size + (size & 1);
  }
  return false;
}

/** contain 스케일 (여백 없이 가장 긴 변을 TARGET에 맞춤) */
function contain(w, h, maxW, maxH) {
  const s = Math.min(maxW / w, maxH / h);
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}