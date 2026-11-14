import assert from "node:assert/strict";
import test from "node:test";
import type {SimRunInput} from "../collider/types.js";
import {computePayouts,DEFAULT_SHARES,distribute,splitAmount} from "./exact-payouts.js";

const asset="09".repeat(32),a="11".repeat(32),b="22".repeat(32);
function input(policy:string,throws:Array<{user:string;value:string;amount:string;hole:number;mass?:number}>){
  const rows=throws.map((t,i)=>({id:(i+1).toString(16).padStart(64,'0'),asset,user:t.user,amount:t.amount,value_usd_e8:t.value,mass_usd:t.mass??0}));
  return {input:{game:{no_winner_policy:policy},map:{},throws:rows} as unknown as SimRunInput,
    outcomes:throws.map((t,i)=>({throw_id:rows[i].id,hole_type:t.hole}))};
}
test("VM splits floor fees and give residual to largest non-fee component, ties Return > Losers > Prize",()=>{
  assert.deepEqual(splitAmount(101n,DEFAULT_SHARES[4]),{returned:52n,prize:0n,losers:49n,fee:0n,creator:0n});
  assert.deepEqual(splitAmount(1n,DEFAULT_SHARES[2]),{returned:0n,prize:0n,losers:1n,fee:0n,creator:0n});
  assert.deepEqual(splitAmount(5n,DEFAULT_SHARES[5]),{returned:5n,prize:0n,losers:0n,fee:0n,creator:0n});
  assert.equal(splitAmount(1n,{return_ppm:500000,losers_ppm:500000,prize_ppm:0,collider_fee_ppm:0,creator_fee_ppm:0}).returned,1n);
});
test("largest remainder conserves every base unit above JS safe-integer range with canonical ID tie-break",()=>{
  assert.deepEqual([...distribute(9n,new Map([[b,2n],[a,2n]]))].sort(),[[a,5n],[b,4n]]);
  const huge=(1n<<127n)+7n,out=distribute(huge,new Map([[b,1n],[a,1n]]));
  assert.equal(out.get(a),(huge+1n)/2n);assert.equal(out.get(b),huge/2n);assert.equal([...out.values()].reduce((x,y)=>x+y,0n),huge);
});
test("BiggestLoser ranks exact economic loss, MostPlayed total canonical value and BiggestBalls largest single canonical value",()=>{
  const throws=[{user:a,value:'100',amount:'100',hole:4,mass:0},{user:b,value:'60',amount:'60',hole:2,mass:9999}];
  for(const [policy,winner]of [['BiggestLoser',b],['MostPlayed',a],['BiggestBalls',a]]){
    const f=input(policy,throws);assert.equal(computePayouts(f.input,f.outcomes).beneficiary,winner);
  }
});
test("fractional canonical losses and equal-value ties never depend on float conversion or insertion order",()=>{
  const f=input('BiggestLoser',[{user:b,value:'1',amount:'100',hole:5},{user:a,value:'1',amount:'100',hole:5},{user:a,value:'1',amount:'100',hole:5}]);
  assert.equal(computePayouts(f.input,f.outcomes).beneficiary,a);
  const tie=input('MostPlayed',[{user:b,value:'9007199254740993',amount:'100',hole:2},{user:a,value:'9007199254740993',amount:'100',hole:2}]);
  assert.equal(computePayouts(tie.input,tie.outcomes).beneficiary,a);
});
test("winner redistribution uses canonical value and integer dust, not mass or asset-close price",()=>{
  const f=input('BiggestLoser',[{user:a,value:'1',amount:'100',hole:3,mass:900},{user:b,value:'1',amount:'100',hole:3,mass:1},{user:b,value:'1',amount:'1',hole:2}]);
  const p=computePayouts(f.input,f.outcomes);assert.equal(p.winners.get(a+':'+asset),1n);assert.equal(p.winners.get(b+':'+asset)??0n,0n);
});
test("Refund clears fees/prize pools and canonical tournament holes 6–9 retain their exact contributions",()=>{
  const f=input('Refund',[{user:a,value:'1',amount:'101',hole:2},{user:b,value:'1',amount:'101',hole:9}]);
  const p=computePayouts(f.input,f.outcomes);assert.equal(p.returns.get(a+':'+asset),101n);assert.equal(p.returns.get(b+':'+asset),101n);assert.equal(p.fees.size+p.prizes.size,0);
  for(const h of [6,7,8,9]){const s=splitAmount(1000000n,DEFAULT_SHARES[h]);assert.equal(s.returned+s.prize,1000000n);assert.equal(s.fee+s.creator,0n);}
});
test("missing/duplicate outcomes, malformed rules, unsafe integers and unknown policy fail closed",()=>{
  const f=input('BiggestLoser',[{user:a,value:'1',amount:'10',hole:2}]);
  assert.throws(()=>computePayouts(f.input,[]));assert.throws(()=>computePayouts(f.input,[{throw_id:'bad',hole_type:2}]));
  assert.throws(()=>computePayouts(f.input,f.outcomes,{}));assert.throws(()=>computePayouts(f.input,f.outcomes,{'2':{CompositeFull:{return_ppm:100}}}));
  assert.throws(()=>splitAmount(1n<<128n,DEFAULT_SHARES[1]));
  const bad=input('bad',[{user:a,value:'1',amount:'10',hole:2}]);assert.throws(()=>computePayouts(bad.input,bad.outcomes));
});

test("zero canonical values retain VM user-ID tie-breaking for no-winner pools",()=>{
  const f=input('MostPlayed',[{user:b,value:'0',amount:'10',hole:2},{user:a,value:'0',amount:'10',hole:2}]);
  const p=computePayouts(f.input,f.outcomes);assert.equal(p.beneficiary,a);assert.equal(p.returns.get(a+':'+asset),20n);
});
