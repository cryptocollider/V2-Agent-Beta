import type {AgentSettings} from '../core/settings.js';
const publicKeys=['rpc','wasm','user','asset','amount','maxCandidates','maxMs','maxSingleThrowBase','maxSingleThrowUsd','maxThrowUsd','maxGameExposureUsd','reserveBalanceBase','allowedAssets','riskMode','doctrinePack','goalWeights','customStrategy'] as const;
export function publicPlanningSettings(settings:AgentSettings){return Object.fromEntries(publicKeys.map(key=>[key,settings[key]]));}
export function keylessPreviewEnvironment(env:NodeJS.ProcessEnv=process.env){const allowed=['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','NODE_EXTRA_CA_CERTS'];return Object.fromEntries(allowed.filter(key=>env[key]!==undefined).map(key=>[key,env[key]!]));}
