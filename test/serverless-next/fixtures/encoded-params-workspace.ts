import {optionalParamsWorkspace} from "./optional-params-workspace";

export const encodedCases=[
  {input:"a%2fb",rendered:"a%2Fb",decoded:"a/b"},
  {input:"caf%c3%a9",rendered:"caf%C3%A9",decoded:"café"},
  {input:"%E6%9D%B1%E4%BA%AC",rendered:"%E6%9D%B1%E4%BA%AC",decoded:"東京"},
  {input:"%252F",rendered:"%252F",decoded:"%2F"},
  {input:"%25252F",rendered:"%25252F",decoded:"%252F"},
  {input:"x%3fy%23z",rendered:"x%3Fy%23z",decoded:"x?y#z"},
  {input:"a%5cb",rendered:"a%5Cb",decoded:"a\\b"},
  {input:"%41",rendered:"A",decoded:"A"},
] as const;

export function encodedParamsWorkspace(){
  const files=optionalParamsWorkspace().filter(file=>file.path!=="app/layout.tsx");
  const replace=(path:string,content:string)=>{files.find(file=>file.path===path)!.content=content;};
  replace("app/(workspace)/[tenant]/layout.tsx",'import Counter from "../../counter";import Client from "../../client";import Controls from "../../controls";export default async function Layout({children,params}){return <html><body><output data-root-layout>{JSON.stringify(await params)}</output><Counter/><Client/><Controls/>{children}</body></html>;}');
  replace("app/client.tsx",'"use client";import {useParams,useSelectedLayoutSegments} from "next/navigation";export default function Client(){return <><output data-all-client>{JSON.stringify(useParams())}</output><output data-selected>{JSON.stringify(useSelectedLayoutSegments())}</output></>;}');
  replace("app/controls.tsx",'"use client";import {useState} from "react";import Link from "next/link";import {useRouter} from "next/navigation";export default function Controls(){const [href,setHref]=useState("/acme/docs/a%2fb"),router=useRouter();return <><input data-target value={href} onChange={event=>setHref(event.target.value)}/><Link data-go href={href} prefetch={false}>go</Link><button data-back onClick={()=>router.back()}>back</button><button data-refresh onClick={()=>router.refresh()}>refresh</button></>;}');
  replace("app/(workspace)/[tenant]/docs/[[...parts]]/layout.tsx",'export default async function Layout({children,aside,params}){return <><output data-nested-layout>{JSON.stringify(await params)}</output>{children}{aside}</>;}');
  replace("app/(workspace)/[tenant]/docs/[[...parts]]/page.tsx",'import {connection} from "next/server";import {tenant} from "next/root-params";import {read} from "../../../../data";export default async function Page({params}){await connection();const own=await params;return <><output data-all-page>{JSON.stringify(own)}</output><output data-root-value>{await tenant()}</output><output data-cache>{JSON.stringify(await read(own))}</output></>;}');
  replace("app/(workspace)/[tenant]/docs/[[...parts]]/@aside/default.tsx",'import {connection} from "next/server";export default async function Default({params}){await connection();return <output data-all-default>{JSON.stringify(await params)}</output>;}');
  replace("app/(workspace)/[tenant]/client/[[...parts]]/page.tsx",'"use client";import {use} from "react";export default function Page({params}){return <output data-all-client-page>{JSON.stringify(use(params))}</output>;}');
  replace("app/(workspace)/[tenant]/scalar/[parts]/page.tsx",'import {connection} from "next/server";export async function generateMetadata({params}){return {title:JSON.stringify(await params)};}export default async function Page({params}){await connection();return <output data-all-page>{JSON.stringify(await params)}</output>;}');
  return files;
}
