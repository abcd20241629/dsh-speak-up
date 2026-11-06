const fs=require('fs'), z=require('zlib');
const f=process.argv[2];
const raw=z.zstdDecompressSync(fs.readFileSync(f)).toString('utf8');
const lines=raw.trim().split('\n');
const out=[];
for(const line of lines){
  let o; try{o=JSON.parse(line)}catch{continue}
  const t=o.type||o.kind||'';
  if(!/user\/message|assistant\/message/.test(t)) continue;
  const m=o.data?.message||o.message||o.data||{};
  const c=m.content;
  let text='';
  if(typeof c==='string') text=c;
  else if(Array.isArray(c)) text=c.map(x=>x?.text||'').join(' ');
  const ts=o.time||o.timestamp||o.ts||o.data?.time||'';
  out.push({t,ts,text:text.replace(/\s+/g,' ').slice(0,160),src:JSON.stringify(m.source||o.data?.source||'').slice(0,80)});
}
for(const x of out.slice(-10)) console.log(x.ts,'|',x.t,'|',x.text,'|',x.src);
console.log('total msgs',out.length);
