import { Interface, Transaction, keccak256 } from "ethers";
import { PUBLIC_RC1, requirePublic } from "./contract.js";
import { ERC20, parseHexQuantity, signStoredTransaction, type StoredEvmTransaction } from "../core/fuji-testnet-funding.js";
import type { AgentWallet } from "../collider/wallet.js";
export type RpcCaller={call<T>(method:string,params?:unknown[],opts?:{retries?:number;timeoutMs?:number}):Promise<T>};
export const EVENTS=new Interface(["event Transfer(address indexed from,address indexed to,uint256 value)",
  "event DepositAccepted(bytes32 indexed asset,address indexed from,address indexed beneficiary,uint256 amount,uint256 cumulativeAmount)"]);
const lower=(v:unknown)=>String(v??"").toLowerCase();
export async function finalizedReceipt(rpc:RpcCaller,hash:string,from:string,to:string):Promise<any|null>{
  requirePublic(/^0x[0-9a-f]{64}$/i.test(hash),"transaction hash missing");
  const r=await rpc.call<any>("eth_getTransactionReceipt",[hash],{retries:0});if(!r)return null;
  requirePublic(lower(r.transactionHash)===lower(hash)&&lower(r.from)===lower(from)&&lower(r.to)===lower(to)
    &&r.status==="0x1"&&/^0x[0-9a-f]{64}$/i.test(r.blockHash),"source receipt reverted/mismatched");
  const height=parseHexQuantity(r.blockNumber,"receipt height"),tip=parseHexQuantity(await rpc.call<string>("eth_blockNumber",[]),"tip");
  if(tip<height+3n)return null;
  const block=await rpc.call<any>("eth_getBlockByNumber",[r.blockNumber,false]);
  requirePublic(block&&lower(block.hash)===lower(r.blockHash),"source finality block hash changed");return r;
}
export async function verifyGrantLeg(rpc:RpcCaller,claim:any,wallet:string,kind:"token"|"gas"):Promise<void>{
  const hash=claim[kind+"_tx_id"],to=kind==="token"?PUBLIC_RC1.token:wallet;
  const r=await finalizedReceipt(rpc,hash,PUBLIC_RC1.dispenser,to);requirePublic(r,"grant leg not finalized; poll original claim");
  const tx=await rpc.call<any>("eth_getTransactionByHash",[hash]);
  requirePublic(tx&&lower(tx.hash)===lower(hash)&&lower(tx.from)===PUBLIC_RC1.dispenser&&lower(tx.to)===lower(to)
    &&lower(tx.blockHash)===lower(r.blockHash),"grant transaction identity mismatch");
  if(kind==="gas")requirePublic(BigInt(tx.value)===BigInt(PUBLIC_RC1.gasGrant)&&(tx.input==="0x"||tx.input==="0x0"),"native gas grant differs");
  else{
    const transfer=new Interface(["function transfer(address recipient,uint256 amount)"]);
    requirePublic(BigInt(tx.value)===0n&&lower(tx.input)===lower(transfer.encodeFunctionData("transfer",[wallet,PUBLIC_RC1.grant])),"token grant calldata differs");
    const matches=(r.logs??[]).filter((l:any)=>lower(l.address)===PUBLIC_RC1.token).flatMap((l:any)=>{try{const e=EVENTS.parseLog(l);return e?.name==="Transfer"&&lower(e.args.from)===PUBLIC_RC1.dispenser&&lower(e.args.to)===lower(wallet)?[e.args.value]:[];}catch{return [];}});
    requirePublic(matches.length===1&&matches[0]===BigInt(PUBLIC_RC1.grant),"exact finalized CLC Transfer missing");
  }
}
export function verifyDepositEvent(receipt:any,wallet:string,expectedCumulative:string):void{
  const matches=(receipt.logs??[]).filter((l:any)=>lower(l.address)===PUBLIC_RC1.custody).flatMap((l:any)=>{try{const e=EVENTS.parseLog(l);
    return e?.name==="DepositAccepted"&&lower(e.args.asset)===PUBLIC_RC1.clc&&lower(e.args.from)===lower(wallet)&&lower(e.args.beneficiary)===lower(wallet)?[e]:[];}catch{return [];}});
  requirePublic(matches.length===1&&matches[0].args.amount===BigInt(PUBLIC_RC1.grant)&&matches[0].args.cumulativeAmount===BigInt(expectedCumulative),"exact finalized custody DepositAccepted missing");
}
export function verifyPublicStored(stored:StoredEvmTransaction,wallet:string,to:string,data:string):void{
  const tx=Transaction.from(stored.rawTransaction);
  requirePublic(lower(tx.from)===lower(wallet)&&lower(tx.to)===lower(to)&&lower(tx.data)===lower(data)&&tx.value===0n&&tx.chainId===43113n
    &&tx.nonce===stored.nonce&&lower(keccak256(stored.rawTransaction))===lower(stored.txHash)&&lower(stored.to)===lower(to)&&lower(stored.data)===lower(data)
    &&tx.gasPrice!=null&&tx.gasPrice<=BigInt(PUBLIC_RC1.maxGasPrice)&&tx.gasLimit*tx.gasPrice<=BigInt(PUBLIC_RC1.maxTransactionFee),"stored source operation scope/nonce/fee mismatch");
}
export async function signPublicOperation(kind:"approval"|"deposit",wallet:AgentWallet,rpc:RpcCaller,to:string,data:string,gasReserve:string,now:()=>Date):Promise<StoredEvmTransaction>{
  const [chain,latest,pending,balance,price]=await Promise.all([rpc.call<string>("eth_chainId",[]),rpc.call<string>("eth_getTransactionCount",[wallet.address,"latest"]),
    rpc.call<string>("eth_getTransactionCount",[wallet.address,"pending"]),rpc.call<string>("eth_getBalance",[wallet.address,"latest"]),rpc.call<string>("eth_gasPrice",[])]);
  requirePublic(BigInt(chain)===43113n&&BigInt(latest)===BigInt(pending),"wrong Fuji chain or unrelated source nonce pending");
  requirePublic(BigInt(price)<=BigInt(PUBLIC_RC1.maxGasPrice)&&BigInt(balance)>=BigInt(gasReserve)+BigInt(PUBLIC_RC1.maxTransactionFee),"insufficient exit gas reserve or gas-price ceiling");
  const stored=await signStoredTransaction({kind,wallet,evm:rpc,to,data,now});
  requirePublic(BigInt(stored.nonce)===BigInt(pending),"source nonce changed before signature");verifyPublicStored(stored,wallet.address,to,data);return stored;
}
