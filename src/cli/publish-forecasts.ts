import path from "node:path";
import { ForecastPublisher, DEFAULT_PUBLISHER_CONFIG, validateConfig, atomic, startForecastPublisher, publisherStatus, loadPublisherConfig } from "../publisher/publisher.js";
import { DEFAULT_IPFS_CONFIG } from "../publisher/ipfs.js";
const args=process.argv.slice(2),arg=(key:string,fallback:string)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};
const dir=arg("--data-dir","data-rc1-public-20261104a");
if(args.includes("--disable")){
  const config=await loadPublisherConfig(dir);config.enabled=false;await atomic(path.join(dir,"forecast-publisher.json"),config);console.log(JSON.stringify({enabled:false,transportRetainedForStatus:true}));
}else if(args.includes("--configure")){
  const targets=args.flatMap((v,i)=>v==="--target"?[args[i+1]]:[]);
  const prior=await loadPublisherConfig(dir);const watermark=args.includes("--new-results-only")?(prior.publishAfter??new Date().toISOString()):prior.publishAfter;
  const config={...DEFAULT_PUBLISHER_CONFIG,...(watermark?{publishAfter:watermark}:{}),enabled:args.includes("--enable"),targets,allowLoopbackHttp:args.includes("--allow-loopback-http"),
    ...(args.includes("--ipfs")?{ipfs:{...DEFAULT_IPFS_CONFIG,enabled:true,kuboApi:arg("--kubo-api",DEFAULT_IPFS_CONFIG.kuboApi),httpFallback:!args.includes("--no-http-fallback"),allowRemoteKubo:args.includes("--allow-remote-kubo"),...(args.includes("--kubo-auth-env")?{authEnv:arg("--kubo-auth-env","")}:{})}}:{})};
  validateConfig(config);await atomic(path.join(dir,"forecast-publisher.json"),config);
  console.log(JSON.stringify({configured:true,...config}));
}else if(args.includes("--watch")){
  const stop=startForecastPublisher(dir,true);let closing=false;
  const close=async()=>{if(closing)return;closing=true;await stop();process.exit(0);};
  process.once("SIGINT",()=>void close());process.once("SIGTERM",()=>void close());
  console.log("Publisher-only watcher; no wallet loaded or gameplay started.");
}else if(args.includes("--once")){
  const max=Number(arg("--max-deliveries","1"));if(!Number.isInteger(max)||max<1||max>10)throw Error("max deliveries must be 1..10");
  console.log(JSON.stringify(await new ForecastPublisher(dir).tick(max)));
}else{
  console.log(JSON.stringify(await publisherStatus(dir)));
}
