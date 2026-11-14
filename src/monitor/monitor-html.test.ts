import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script, runInNewContext } from "node:vm";

test("manager detection handles unavailable Ollama without installer or paid chat side effects",async()=>{
  const html=await readFile(new URL("../../monitor21.html",import.meta.url),"utf8");
  const source=html.slice(html.indexOf("async function autoDetectManagerLlm("),html.indexOf("function collectOnboardingSnapshot("));
  for(const failure of [false,true]){
    const state:any={busy:false};let saved=0,renders=0;const calls:string[]=[];
    const context={managerLocalSetupState:state,managerLlmConfigDraftDirty:false,managerDockConnectionExpanded:false,
      setManagerLocalSetupState:(patch:object)=>Object.assign(state,patch),renderAll:()=>renders++,
      setManagerLlmStateClient:()=>saved++,postJson:async(url:string,body:any)=>{
        calls.push(url);assert.equal(body.prefer,"ollama");if(failure)throw Error("HTTP 404");
        return {ok:true,state:{},detected:{label:"Ollama (installed)"}};
      }};
    await runInNewContext(source+";autoDetectManagerLlm();",context);
    assert.deepEqual(calls,["/api/manager/llm/autodetect"]);assert.equal(saved,failure?0:1);
    assert.equal(state.busy,false);assert.equal(renders,1);
    if(failure)assert.match(state.message,/Start Ollama with an installed model/);
  }
  assert.doesNotMatch(html,/autoSetupLocalManagerLlm|\/api\/manager\/llm\/local-setup/);
});

test("bonded checkbox stays in the integrated points panel, starts unchecked and uses only same-origin status/config", async () => {
  const html = await readFile(new URL("../../points-clc.html", import.meta.url), "utf8");
  assert.match(html, /id="confirmationEnabled" type="checkbox" disabled>/);
  assert.match(html, /\/api\/confirmations\/status/); assert.match(html, /\/api\/confirmations\/config/);
  assert.match(html, /getVerificationStats/); assert.match(html, /accepted bonds still recover and reveal/);
  assert.doesNotMatch(html, /id="confirmationEnabled"[^>]*\schecked/);
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(match[1]);
});

test("games review uses durable RC1 prediction and settled-game fallbacks", async () => {
  const html = await readFile(new URL("../../monitor21.html", import.meta.url), "utf8");

  assert.match(html, /\.\.\.\(runRows \|\| \[\]\), \.\.\.\(throwRows \|\| \[\]\)/);
  assert.match(html, /\/api\/history\/game\?gameId=/);
  assert.match(html, /const canonicalStakeUsd = Number\(wg\?\.stake_usd\)/);
  assert.match(html, /Object\.values\(wg\?\.hole_type_counts \|\| \{\}\)/);
  assert.doesNotMatch(html, /missing run\.prediction\.pnlUsd/);
  assert.doesNotMatch(html, /missing game\.stake/);
});

test("games review distinguishes lifetime counters from the 100-game review window", async () => {
  const html = await readFile(new URL("../../monitor21.html", import.meta.url), "utf8");

  assert.match(html, /fetchJson\('\/api\/history\/summary'/);
  assert.match(html, /id="lifetimeThrowsCount"/);
  assert.match(html, /id="lifetimeResultsCount"/);
  assert.match(html, /Lifetime Games/);
  assert.match(html, /Recent Games <span class="muted">\(newest 100 games\)<\/span>/);
  assert.match(html, /Recent PnL USD/);
  assert.match(html, /Recent Games In Window/);
  assert.match(html, /Agent A \/ Chain T/);
  assert.match(html, /id="gamesWindowLimit"/);
  assert.match(html, /gamesWindowLimit = 100/);
  assert.match(html, /historySummary\?\.recentGames/);
  assert.match(html, /Number\(summary\?\.resolved \|\| 0\) > 0 \|\| canonical/);
  assert.doesNotMatch(html, /Number\.isFinite\(liveStatus\) && liveStatus < 2/);
  assert.match(html, /fetchVersionedJson\('\/api\/logs\/throws\?limit=1600'/);
  assert.match(html, /per_game_cap: 'CAP\/G'/);
  assert.match(html, /max_s: 'CAP\/S'/);
  assert.match(html, /not a throw-size limit/);
});

test("points and CLC stays inside the main monitor and uses same-origin ledger reads", async () => {
  const html = await readFile(new URL("../../monitor21.html", import.meta.url), "utf8");
  const points = await readFile(new URL("../../points-clc.html", import.meta.url), "utf8");
  assert.match(html, /id="pointsSection"/);
  assert.match(html, /id="pointsFrame"[^>]+src="\/points-clc\.html\?embedded=1"/);
  assert.match(html, /setMainView\('points'\)/);
  assert.match(points, /\/api\/points\/ledger/);
  assert.match(points, /\/api\/points\/quote\?pointsIn=/);
  assert.doesNotMatch(points, /fetch\(ctx\.rpc/);
});

test("Bank uses same-origin wallet balances and durable wallet play flows", async () => {
  const html = await readFile(new URL("../../monitor21.html", import.meta.url), "utf8");
  assert.match(html, /fetchJson\('\/api\/bank\/balances'/);
  assert.match(html, /historySummary\?\.bank/);
  assert.match(html, /Current Wallet/);
  assert.match(html, /Unsettled Stake/);
  assert.match(html, /no zero balance is inferred/);
  assert.doesNotMatch(html, /rpcCall\(settings\.rpc, 'colliderV2\.getBalances'/);
});

test("browser-side artifact and disconnected-manager queues stay bounded", async () => {
  const html = await readFile(new URL("../../monitor21.html", import.meta.url), "utf8");

  assert.match(html, /MAX_PREDICTION_ARTIFACT_CACHE_ENTRIES = 160/);
  assert.match(html, /trimMapOldest\(predictionCommitArtifacts, MAX_PREDICTION_ARTIFACT_CACHE_ENTRIES\)/);
  assert.match(html, /trimMapOldest\(predictionRevealArtifacts, MAX_PREDICTION_ARTIFACT_CACHE_ENTRIES\)/);
  assert.match(html, /MAX_MANAGER_EVENT_SEEN_KEYS = 512/);
  assert.match(html, /MAX_PENDING_MANAGER_EVENT_NOTICES = 128/);
  assert.match(html, /pendingManagerEventNotices\.splice\(0, pendingManagerEventNotices\.length - MAX_PENDING_MANAGER_EVENT_NOTICES\)/);
});

test("recent log polling reuses unchanged responses through ETags", async () => {
  const html = await readFile(new URL("../../monitor21.html", import.meta.url), "utf8");

  assert.match(html, /const versionedJsonResponses = new Map\(\)/);
  assert.match(html, /'if-none-match': cached\.etag/);
  assert.match(html, /response\.status === 304 && cached/);
  assert.match(html, /fetchVersionedJson\('\/api\/logs\/runs\?limit=100'/);
  assert.match(html, /fetchVersionedJson\('\/api\/logs\/throws\?limit=100'/);
  assert.match(html, /fetchVersionedJson\('\/api\/logs\/results\?limit=100'/);
});

test("startup guide exposes opt-in Fuji funding state without presenting it as production funding", async () => {
  const html = await readFile(new URL("../../monitor21.html", import.meta.url), "utf8");

  assert.match(html, /snapshot\.onboarding\?\.testnetAutoFunding/);
  assert.match(html, /Fuji auto-funding:/);
  assert.match(html, /pinned Fuji RC1 testnet only/);
  assert.match(html, /disabled by default/);
});

test("legacy local payout amounts cannot be promoted to exact UI credits", async () => {
  const html = await readFile(new URL("../../monitor21.html", import.meta.url), "utf8");
  const source = html.slice(html.indexOf("function resultRowOutputAssetMap("), html.indexOf("function buildResolvedDeltaRows("));
  assert.match(source, /returned_by_asset_source/);
  assert.match(source, /source:'legacy_throw_estimate', map, exact:false/);
  assert.match(html, /bank totals use canonical game payouts/);
});

test("Games Review priority select has ten choices, shared canonical map ID and protected live focus", async () => {
  const html=await readFile(new URL('../../monitor21.html',import.meta.url),'utf8');
  for(const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(match[1]);
  const source=html.slice(html.indexOf('function mapPriorityControlHtml('),html.indexOf('async function saveMapPriority('));
  const id='12'.repeat(32),context={settings:{mapPriorities:{[id]:10}},mapPrioritySaving:false,
    cleanHex:(v:string)=>v.replace(/^0x/,'').toLowerCase(),esc:(v:string)=>v,escAttr:(v:string)=>v,shortHex:(v:string)=>v.slice(0,12)};
  const rendered=runInNewContext(source+`;mapPriorityControlHtml({mapId:'0x${id}',gameName:'Moving Classic'});`,context);
  assert.equal((rendered.match(/<option /g)||[]).length,10);assert.match(rendered, /value="10" selected/);
  assert.ok(rendered.includes('data-map-id="'+id+'"'));assert.match(rendered,/Moving Classic/);
  assert.match(html,/event\.stopPropagation\(\)/);assert.match(html,/tr\.contains\(document\.activeElement\)/);
  assert.match(html,/\/api\/settings\/map-priority/);assert.match(html,/runtimeSyncPending \|\| saved\.runtimeSyncError/);
});
