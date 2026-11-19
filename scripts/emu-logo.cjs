const fs = require('node:fs');
const zlib = require('node:zlib');
// Each character is one pixel. Dots are transparent.
const rows = [
  '..........DD....',
  '.........DBTD...',
  '.........DTDTDD.',
  '..........DTTTD.',
  '..........DBD...',
  '..........DTD...',
  '....DDD...DTD...',
  '..DDBBBD..DTD...',
  '.DBTBTBBDDBTD...',
  '.DBTBBTBBBTTD...',
  'DBBTBTBTBBBD....',
  '.DBTBBTBBBD.....',
  '..DDDDDDDD......',
  '....D...D.......',
  '....D...D.......',
  '....DD..DD......',
];
const colors = {'.':[0,0,0,0], D:[45,39,36,255], B:[143,98,62,255], T:[235,200,146,255]};
function crc(b) { let c=0xffffffff; for(const v of b){c^=v;for(let k=0;k<8;k++) c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0; }
function chunk(type,data){const t=Buffer.from(type),n=Buffer.alloc(4),c=Buffer.alloc(4);n.writeUInt32BE(data.length);c.writeUInt32BE(crc(Buffer.concat([t,data])));return Buffer.concat([n,t,data,c]);}
function save(path,scale){const size=16*scale;const raw=Buffer.alloc(size*(1+size*4));for(let y=0;y<size;y++)for(let x=0;x<size;x++){const color=colors[rows[Math.floor(y/scale)][Math.floor(x/scale)]];raw.set(color,y*(1+size*4)+1+x*4);}const h=Buffer.alloc(13);h.writeUInt32BE(size,0);h.writeUInt32BE(size,4);h[8]=8;h[9]=6;fs.writeFileSync(path,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]));}
if(rows.length!==16 || rows.some(r=>r.length!==16))throw Error('Expected 16x16 grid');
save('assets/emu-logo-16-v2.png',1);
save('assets/emu-logo-16-v2-preview.png',20);
