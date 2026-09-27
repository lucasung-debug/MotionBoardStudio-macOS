'use strict';

// studio-video:// 응답 생성. <video> 탐색(seek)을 위해 HTTP Range 요청을 처리한다(electron 비의존).

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { Readable } = require('stream');

const MEDIA_TYPES = { '.mp4': 'video/mp4', '.png': 'image/png', '.jpg': 'image/jpeg', '.html': 'text/plain; charset=utf-8' };

// "bytes=a-b" / "bytes=a-" / "bytes=-n" → { start, end } 또는 null(형식 오류), 'unsatisfiable'
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start, end;
  if (m[1]) {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  } else {
    const suffix = Number(m[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  }
  if (!(start >= 0 && start < size && end >= start)) return 'unsatisfiable';
  return { start, end };
}

async function mediaResponse(file, rangeHeader) {
  const { size } = await fsp.stat(file);
  const type = MEDIA_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = rangeHeader ? parseRange(rangeHeader, size) : null;
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
  }
  if (range) {
    return new Response(Readable.toWeb(fs.createReadStream(file, { start: range.start, end: range.end })), {
      status: 206,
      headers: {
        'content-type': type,
        'content-length': String(range.end - range.start + 1),
        'content-range': `bytes ${range.start}-${range.end}/${size}`,
        'accept-ranges': 'bytes'
      }
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), {
    status: 200,
    headers: { 'content-type': type, 'content-length': String(size), 'accept-ranges': 'bytes' }
  });
}

module.exports = { MEDIA_TYPES, parseRange, mediaResponse };
