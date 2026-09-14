// Build only in an isolated temporary Cargo project with rustdx-complete 1.11.0
// and serde_json. Each invocation queries one case; the parent bounds wall time.
use rustdx_complete::tcp::{Tcp, TcpConfig, Tdx, ip, stock::*};
use serde_json::{Value, json};
use std::{fmt::Debug, time::Duration};

fn items<T: Debug>(v: Vec<T>) -> Value {
    json!({"status": if v.is_empty() {"empty"} else {"data"}, "count":v.len(),
        "first":v.first().map(|x|format!("{x:?}")), "last":v.last().map(|x|format!("{x:?}"))})
}
fn point_items(v: Vec<MinuteTimeData>) -> Value {
    let points:Vec<_>=v.iter().map(|p|json!({"price":p.price,"vol":p.vol})).collect();
    let mut result=items(v); result["points"]=json!(points); result
}
fn run(host:&str, name:&str, market:u16, code:&str, category:u16) -> Result<Value,Box<dyn std::error::Error>> {
    if name=="price_limits" {
        use rustdx_complete::limit::{board_of,limit_up_price,limit_down_price};
        let board=board_of(code).ok_or("unknown board")?;
        return Ok(json!({"status":"data","mode":"local-calculation","up":limit_up_price(9.26,board,false),"down":limit_down_price(9.26,board,false)}));
    }
    let cfg=TcpConfig {ip:Some(format!("{host}:7709").parse()?), timeout:Duration::from_secs(3),auto_reconnect:0,recheck_empty:false,..Default::default()};
    if name=="check_alive" {return Ok(items(ip::check_alive(Duration::from_secs(1))));}
    if name=="check_alive_protocol" {return Ok(items(ip::check_alive_protocol(Duration::from_secs(1))));}
    if name=="check_alive_by_rtt" {return Ok(items(ip::check_alive_by_rtt(Duration::from_secs(1))));}
    if name=="tcp_connect_ok" {return Ok(json!({"status":"data","value":ip::tcp_connect_ok(&cfg.ip.unwrap(),Duration::from_secs(3))}));}
    if name=="minute_raw" || name=="security_list_page" || name=="company_content" || name=="block_meta" || name=="block_chunk" {
        let mut tcp=Tcp::with_config(&cfg)?;
        return Ok(match name {
            "minute_raw"=>{let mut x=MinuteTime::new(market,code);x.recv_parsed(&mut tcp)?; let mut r=point_items(x.result().to_vec());r["bytes"]=json!(x.response.len());r},
            "security_list_page"=>{let mut x=SecurityList::new(market,0);x.recv_parsed(&mut tcp)?;items(x.result().to_vec())},
            "company_content"=>{let mut cat=CompanyInfoCategory::new(market,code);cat.recv_parsed(&mut tcp)?;if let Some(i)=cat.result().first(){let mut x=CompanyInfoContent::new(market,code,&i.filename,i.start,i.length);x.recv_parsed(&mut tcp)?;json!({"status":if x.data.is_empty(){"empty"}else{"data"},"characters":x.data.chars().count(),"filename":i.filename,"prefix":x.data.chars().take(100).collect::<String>()})}else{json!({"status":"dependency-empty"})}},
            "block_meta"=>{let mut x=BlockInfoMeta::new("block_gn.dat");x.recv_parsed(&mut tcp)?;json!({"status":if x.size>0{"data"}else{"empty"},"bytes":x.size})},
            _=>{let mut x=BlockInfoChunk::new("block_gn.dat",0,30000);x.recv_parsed(&mut tcp)?;json!({"status":if x.data.is_empty(){"empty"}else{"data"},"bytes":x.data.len()})}
        });
    }
    let mut c=Client::with_config(&cfg)?;
    Ok(match name {
        "quotes"=>items(c.quotes(&[(market,code),(0,"300750")])?),
        "bars"=>items(c.bars(market,code,category,0,3)?),
        "index_bars"=>items(c.index_bars(1,"000001",category,0,3)?),
        "bars_range"=>items(c.bars_range(market,code,category,Some(20260910),Some(20260914))?),
        "index_bars_range"=>items(c.index_bars_range(1,"000001",category,Some(20260910),Some(20260914))?),
        "k"=>items(c.k(market,code,Some(20260910),Some(20260914))?),
        "k_adjusted"=>items(c.k_adjusted(market,code,Adj::Qfq,Some(20260910),Some(20260914))?),
        "k_adjusted_hfq"=>items(c.k_adjusted(market,code,Adj::Hfq,Some(20260910),Some(20260914))?),
        "k_batch"=>{let v=c.k_batch(&[(market,code),(0,"300750")],Some(20260910),Some(20260914),1)?;json!({"status":"batch","host_scope":"library-default-pool","items":v.iter().map(|x|match &x.result {Ok(v)=>json!({"code":x.code,"count":v.len(),"status":if v.is_empty(){"empty"}else{"data"}}),Err(e)=>json!({"code":x.code,"status":"error","error":e.to_string()})}).collect::<Vec<_>>()})},
        "bars_batch"=>{let v=c.bars_batch(&[(market,code),(0,"300750")],category,Some(20260910),Some(20260914),1)?;json!({"status":"batch","host_scope":"library-default-pool","items":v.iter().map(|x|match &x.result {Ok(v)=>json!({"code":x.code,"count":v.len(),"status":if v.is_empty(){"empty"}else{"data"}}),Err(e)=>json!({"code":x.code,"status":"error","error":e.to_string()})}).collect::<Vec<_>>()})},
        "minute"=>point_items(c.minute(market,code)?),
        "history_minute"=>point_items(c.history_minute(market,code,20260914)?),
        "transaction"=>items(c.transaction(market,code,0,3)?),
        "history_transaction"=>items(c.history_transaction(market,code,0,3,20260914)?),
        "finance"=>{let v=c.finance(market,code)?;json!({"status":"data","value":format!("{v:?}")})},
        "xdxr"=>items(c.xdxr(market,code)?),
        "block"=>items(c.block("block_gn.dat")?),
        "block_zs"=>items(c.block("block_zs.dat")?),
        "block_fg"=>items(c.block("block_fg.dat")?),
        "stock_count"=>{let n=c.stock_count(market)?;json!({"status":if n>0{"data"}else{"empty"},"value":n})},
        "stocks"=>items(c.stocks(market)?),
        "f10_categories"=>items(c.f10_categories(market,code)?),
        "f10"=>{let v=c.f10(market,code)?;json!({"status":if v.is_empty(){"empty"}else{"data"},"count":v.len(),"sections":v.iter().map(|(title,s)|json!({"title":title,"characters":s.chars().count()})).collect::<Vec<_>>()})},
        "heartbeat"=>json!({"status":"data","value":c.heartbeat()?}),
        "reconnect"=>{c.reconnect()?;json!({"status":"data","value":c.heartbeat()?})},
        "retry"=>{let n=c.retry(|tcp|tcp.heartbeat(),1)?;json!({"status":"data","value":n})},
        _=>return Err(format!("unknown case: {name}").into())
    })
}
fn main(){
    let a:Vec<_>=std::env::args().collect();
    let result=run(&a[1],&a[2],a.get(3).and_then(|x|x.parse().ok()).unwrap_or(1),a.get(4).map(String::as_str).unwrap_or("600000"),a.get(5).and_then(|x|x.parse().ok()).unwrap_or(4));
    println!("{}",match result{Ok(v)=>v,Err(e)=>json!({"status":"error","error":e.to_string()})});
}
