import * as c from "../packages/core/dist/index.js";
const MB=1024*1024;
const rep=(s)=>s.repeat(Math.ceil(MB/s.length)).slice(0,MB);
const step=(body)=>({id:"s",runId:"r",index:1,kind:"form_submit",timestamp:5,url:"http://a.test/page",flags:[],request:{method:"POST",url:"http://b.test/c",bodyPreview:body}});
for (const [n,t] of [["a",rep("a")],["digits",rep("1")],["dash",rep("1-")],["dots",rep("a.")],["sk",rep("sk-")]]) {
  const time=(label,f)=>{const s=performance.now();f();console.log(n,label,(performance.now()-s).toFixed(0));};
  time("hidden",()=>c.hiddenInstruction({nodes:[{text:t,display:"none"}]}));
  time("sensOut",()=>c.sensitiveOutbound({method:"POST",url:"http://b.test/c",bodyPreview:t},"http://a.test/"));
  time("crossDom",()=>c.crossDomainData(step(t),[{url:"http://a.test/page",text:t}]));
  time("findSens",()=>c.findSensitive(t));
  time("redact",()=>c.redactText(t));
}
