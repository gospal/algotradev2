/* ============================================================
   Confluence — Crypto Signal Terminal (v2)
   Adds: RSI, MACD, Bollinger Bands, volume confirmation,
   support/resistance key levels, a 1H timeframe panel, and an
   overall-bias summary combining all three timeframes.
   ============================================================ */

const API = 'https://api.binance.com/api/v3/klines';
const TICKER_API = 'https://api.binance.com/api/v3/ticker/24hr';

const TIMEFRAMES = [
  { key: '15m', interval: '15m', label: '15 Minute', title: 'Scalp Window', weight: 0.8 },
  { key: '1h',  interval: '1h',  label: '1 Hour',     title: 'Swing Window', weight: 1.0 },
  { key: '1d',  interval: '1d',  label: '1 Day',      title: 'Position Window', weight: 1.3 }
];

const SYMBOLS = [
  'BTCUSDT','ETHUSDT','XRPUSDT','SOLUSDT','BNBUSDT','ADAUSDT','DOGEUSDT',
  'AVAXUSDT','LINKUSDT','DOTUSDT','LTCUSDT','TRXUSDT','TONUSDT','SUIUSDT',
  'ARBUSDT','OPUSDT'
];

let currentSymbol = 'BTCUSDT';

/* ---------------- clock ---------------- */
function tickClock(){
  const el = document.getElementById('clock');
  if(el) el.textContent = new Date().toUTCString().slice(0,25) + ' UTC';
}
tickClock(); setInterval(tickClock, 1000);

/* ---------------- math helpers ---------------- */
function ema(values, period){
  const k = 2/(period+1);
  const out = new Array(values.length).fill(null);
  if(values.length < period) return out;
  let prev = values.slice(0, period).reduce((a,b)=>a+b,0)/period;
  out[period-1] = prev;
  for(let i=period;i<values.length;i++){
    prev = values[i]*k + prev*(1-k);
    out[i] = prev;
  }
  return out;
}

function sma(values, period){
  const out = new Array(values.length).fill(null);
  for(let i=period-1;i<values.length;i++){
    let sum=0;
    for(let j=i-period+1;j<=i;j++) sum+=values[j];
    out[i]=sum/period;
  }
  return out;
}

function atr(candles, period){
  const trs = [];
  for(let i=1;i<candles.length;i++){
    const c = candles[i], p = candles[i-1];
    const tr = Math.max(c.high-c.low, Math.abs(c.high-p.close), Math.abs(c.low-p.close));
    trs.push(tr);
  }
  const out = [];
  if(trs.length < period) return out;
  let prev = trs.slice(0,period).reduce((a,b)=>a+b,0)/period;
  out[period] = prev;
  for(let i=period+1;i<trs.length+1;i++){
    prev = (prev*(period-1) + trs[i-1])/period;
    out[i] = prev;
  }
  return out; // index-aligned to candles (out[i] = ATR ending at candles[i])
}

function rsi(closes, period=14){
  const out = new Array(closes.length).fill(null);
  if(closes.length <= period) return out;
  let gains=0, losses=0;
  for(let i=1;i<=period;i++){
    const diff = closes[i]-closes[i-1];
    if(diff>=0) gains+=diff; else losses-=diff;
  }
  let avgGain = gains/period, avgLoss = losses/period;
  out[period] = avgLoss===0 ? 100 : 100-(100/(1+avgGain/avgLoss));
  for(let i=period+1;i<closes.length;i++){
    const diff = closes[i]-closes[i-1];
    const gain = diff>0?diff:0;
    const loss = diff<0?-diff:0;
    avgGain = (avgGain*(period-1)+gain)/period;
    avgLoss = (avgLoss*(period-1)+loss)/period;
    out[i] = avgLoss===0 ? 100 : 100-(100/(1+avgGain/avgLoss));
  }
  return out;
}

function macd(closes, fast=12, slow=26, signalP=9){
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_,i)=> (emaFast[i]!=null && emaSlow[i]!=null) ? emaFast[i]-emaSlow[i] : null);
  const vals = [], idxMap = [];
  macdLine.forEach((v,i)=>{ if(v!=null){ vals.push(v); idxMap.push(i); } });
  const signalRaw = ema(vals, signalP);
  const signalLine = new Array(closes.length).fill(null);
  signalRaw.forEach((v,k)=>{ if(v!=null) signalLine[idxMap[k]] = v; });
  const hist = closes.map((_,i)=> (macdLine[i]!=null && signalLine[i]!=null) ? macdLine[i]-signalLine[i] : null);
  return { macdLine, signalLine, hist };
}

function bollinger(closes, period=20, mult=2){
  const out = new Array(closes.length).fill(null);
  for(let i=period-1;i<closes.length;i++){
    const slice = closes.slice(i-period+1, i+1);
    const mean = slice.reduce((a,b)=>a+b,0)/period;
    const variance = slice.reduce((a,b)=>a+(b-mean)**2,0)/period;
    const sd = Math.sqrt(variance);
    out[i] = { mid: mean, upper: mean+mult*sd, lower: mean-mult*sd };
  }
  return out;
}

function volumeStats(candles, period=20){
  const vols = candles.map(c=>c.volume);
  const last = vols[vols.length-1];
  const start = Math.max(0, vols.length-1-period);
  const slice = vols.slice(start, vols.length-1);
  const avg = slice.length ? slice.reduce((a,b)=>a+b,0)/slice.length : last;
  return { last, avg, ratio: avg ? last/avg : 1 };
}

// simple fractal swing detection: pivot high/low with `look` bars each side
function findSwings(candles, look){
  const highs = [], lows = [];
  for(let i=look; i<candles.length-look; i++){
    let isHigh = true, isLow = true;
    for(let j=i-look;j<=i+look;j++){
      if(j===i) continue;
      if(candles[j].high >= candles[i].high) isHigh = false;
      if(candles[j].low <= candles[i].low) isLow = false;
    }
    if(isHigh) highs.push({i, price: candles[i].high});
    if(isLow) lows.push({i, price: candles[i].low});
  }
  return {highs, lows};
}

function detectTrend(candles, emaFast, emaMid, emaSlow, swings){
  const last = candles.length-1;
  const price = candles[last].close;
  const f = emaFast[last], m = emaMid[last], s = emaSlow[last];
  let emaScore = 0;
  if(f!=null && m!=null && s!=null){
    if(f>m && m>s && price>f) emaScore = 1;
    else if(f<m && m<s && price<f) emaScore = -1;
  }
  let structScore = 0;
  const h = swings.highs, l = swings.lows;
  if(h.length>=2 && l.length>=2){
    const hUp = h[h.length-1].price > h[h.length-2].price;
    const lUp = l[l.length-1].price > l[l.length-2].price;
    if(hUp && lUp) structScore = 1;
    else if(!hUp && !lUp) structScore = -1;
  }
  const combined = emaScore + structScore;
  let dir = 'neutral';
  if(combined >= 1) dir = 'up';
  else if(combined <= -1) dir = 'down';
  return {dir, emaScore, structScore};
}

function nearestFibHit(price, levels, tolPct){
  let best = null;
  for(const lv of levels){
    const dist = Math.abs(price - lv.price)/price;
    if(dist <= tolPct && (best===null || dist < best.dist)){
      best = {...lv, dist};
    }
  }
  return best;
}

function fibLevels(swingHigh, swingLow, dirIsRetraceFromHigh){
  const range = swingHigh - swingLow;
  const ratios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  return ratios.map(r=>{
    const price = dirIsRetraceFromHigh ? swingHigh - range*r : swingLow + range*r;
    return {ratio:r, price};
  });
}

function candlePattern(candles){
  const n = candles.length-1;
  const c = candles[n], p = candles[n-1];
  const body = Math.abs(c.close-c.open);
  const range = c.high-c.low || 1e-9;
  const upperWick = c.high - Math.max(c.close,c.open);
  const lowerWick = Math.min(c.close,c.open) - c.low;
  const patterns = [];

  if(p.close < p.open && c.close > c.open && c.close >= p.open && c.open <= p.close){
    patterns.push({name:'Bullish Engulfing', dir:1});
  }
  if(p.close > p.open && c.close < c.open && c.open >= p.close && c.close <= p.open){
    patterns.push({name:'Bearish Engulfing', dir:-1});
  }
  if(lowerWick > body*2 && lowerWick/range > 0.5 && upperWick/range < 0.2){
    patterns.push({name:'Bullish Pin Bar', dir:1});
  }
  if(upperWick > body*2 && upperWick/range > 0.5 && lowerWick/range < 0.2){
    patterns.push({name:'Bearish Pin Bar', dir:-1});
  }
  return patterns;
}

function keyLevels(swings, price){
  const below = swings.lows.map(l=>l.price).filter(p=>p<price).sort((a,b)=>b-a);
  const above = swings.highs.map(h=>h.price).filter(p=>p>price).sort((a,b)=>a-b);
  return { support: below[0] ?? null, resistance: above[0] ?? null };
}

/* ---------------- confluence scoring ---------------- */
function computeScore({trendDirVal, fibHitLevel, patternDir, rsiVal, macdHist, macdHistPrev, bbVal, price, volRatio, lastCandleUp}){
  let score = 0;
  if(trendDirVal !== 0) score += 18;

  if(fibHitLevel){
    score += (fibHitLevel.ratio===0.5 || fibHitLevel.ratio===0.618) ? 24 : 14;
  }

  if(patternDir !== 0 && patternDir === trendDirVal) score += 16;
  else if(patternDir !== 0) score += 5;

  if(rsiVal!=null && trendDirVal!==0){
    if(trendDirVal===1){
      if(rsiVal>=40 && rsiVal<=70) score += 10;
      else if(rsiVal>75) score -= 6;
    } else {
      if(rsiVal<=60 && rsiVal>=30) score += 10;
      else if(rsiVal<25) score -= 6;
    }
  }

  if(macdHist!=null && trendDirVal!==0){
    if(Math.sign(macdHist)===trendDirVal) score += 12;
    if(macdHistPrev!=null && Math.sign(macdHistPrev)!==trendDirVal && Math.sign(macdHist)===trendDirVal) score += 6;
  }

  if(bbVal && trendDirVal!==0){
    const width = (bbVal.upper - bbVal.lower) || 1;
    const posPct = (price - bbVal.lower)/width; // 0 at lower band .. 1 at upper band
    if(trendDirVal===1){
      if(posPct<0.35) score += 8;
      else if(posPct>0.9) score -= 4;
    } else {
      if(posPct>0.65) score += 8;
      else if(posPct<0.1) score -= 4;
    }
  }

  if(volRatio!=null && trendDirVal!==0){
    if(volRatio>1.5 && lastCandleUp===(trendDirVal===1)) score += 8;
    else if(volRatio<0.5) score -= 3;
  }

  score = Math.max(0, Math.min(100, score));
  let direction = 'neutral';
  if(trendDirVal===1 && score>=50) direction = 'long';
  else if(trendDirVal===-1 && score>=50) direction = 'short';
  return { score, direction };
}

/* ---------------- core analysis ---------------- */
function analyze(rawCandles){
  const candles = rawCandles.map(k=>({
    time:k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5]
  }));
  const closes = candles.map(c=>c.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const e200 = closes.length>200 ? ema(closes, 200) : ema(closes, Math.min(100, Math.floor(closes.length/2)));
  const atrArr = atr(candles, 14);
  const last = candles.length-1;
  const price = candles[last].close;
  const currentATR = atrArr[atrArr.length-1] || (candles[last].high-candles[last].low);

  const swings = findSwings(candles, 4);
  const trend = detectTrend(candles, e20, e50, e200, swings);
  const trendDirVal = trend.dir==='up' ? 1 : trend.dir==='down' ? -1 : 0;

  let fibData = null, fibHitLevel = null;
  const h = swings.highs, l = swings.lows;
  if(h.length && l.length){
    const lastHigh = h[h.length-1];
    const lastLow = l[l.length-1];
    const retraceFromHigh = lastHigh.i > lastLow.i;
    const swingHighPrice = Math.max(lastHigh.price, lastLow.price);
    const swingLowPrice = Math.min(lastHigh.price, lastLow.price);
    const levels = fibLevels(swingHighPrice, swingLowPrice, retraceFromHigh);
    fibData = {levels, swingHighPrice, swingLowPrice, retraceFromHigh};
    fibHitLevel = nearestFibHit(price, levels.filter(lv=>lv.ratio>0 && lv.ratio<1), 0.006);
  }

  const patterns = candlePattern(candles);
  const patternDir = patterns.length ? patterns[patterns.length-1].dir : 0;

  const rsiArr = rsi(closes, 14);
  const rsiVal = rsiArr[rsiArr.length-1];

  const macdData = macd(closes, 12, 26, 9);
  const macdHist = macdData.hist[macdData.hist.length-1];
  const macdHistPrev = macdData.hist[macdData.hist.length-2];

  const bbArr = bollinger(closes, 20, 2);
  const bbVal = bbArr[bbArr.length-1];

  const vol = volumeStats(candles, 20);
  const lastCandleUp = candles[last].close > candles[last].open;

  const {score, direction} = computeScore({
    trendDirVal, fibHitLevel, patternDir, rsiVal, macdHist, macdHistPrev,
    bbVal, price, volRatio: vol.ratio, lastCandleUp
  });

  let stopPrice = null;
  if(direction!=='neutral' && l.length && h.length){
    if(direction==='long'){
      const structuralStop = l[l.length-1].price;
      stopPrice = Math.min(structuralStop, price - currentATR*1.5);
    } else {
      const structuralStop = h[h.length-1].price;
      stopPrice = Math.max(structuralStop, price + currentATR*1.5);
    }
  }
  const stopDistPct = stopPrice ? Math.abs(price-stopPrice)/price*100 : null;
  const levels = keyLevels(swings, price);

  return {
    price, trend, trendDirVal, score, direction, fibData, fibHitLevel, patterns,
    stopPrice, stopDistPct, currentATR, swings, rsiVal, macdHist, macdHistPrev,
    bbVal, vol, levels, closes
  };
}

/* ---------------- rendering ---------------- */
function fmtPrice(p){
  if(p==null) return '—';
  if(p>=1000) return p.toLocaleString(undefined,{maximumFractionDigits:2});
  if(p>=1) return p.toFixed(4);
  return p.toFixed(6);
}

function gaugeSVG(score, dir){
  const angle = (score/100)*180;
  const rad = (angle-180)*Math.PI/180;
  const cx=64, cy=64, r=50;
  const x = cx + r*Math.cos(rad);
  const y = cy + r*Math.sin(rad);
  const color = dir==='long' ? 'var(--long)' : dir==='short' ? 'var(--short)' : 'var(--gold)';
  return `
  <svg width="128" height="74" viewBox="0 0 128 74">
    <path d="M 14 64 A 50 50 0 0 1 114 64" fill="none" stroke="#232830" stroke-width="9" stroke-linecap="round"/>
    <path d="M 14 64 A 50 50 0 0 1 114 64" fill="none" stroke="${color}" stroke-width="9" stroke-linecap="round"
      stroke-dasharray="${(score/100)*157} 157"/>
    <line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="${color}" stroke-width="2.5"/>
    <circle cx="${cx}" cy="${cy}" r="4" fill="${color}"/>
  </svg>`;
}

function sparklineSVG(closes){
  if(!closes || closes.length<2) return '';
  const w=140,h=36,pad=2;
  const slice = closes.slice(-40);
  const min = Math.min(...slice), max = Math.max(...slice);
  const span = (max-min) || 1;
  const stepX = (w-pad*2)/(slice.length-1);
  const pts = slice.map((v,i)=>{
    const x = pad + i*stepX;
    const y = h-pad - ((v-min)/span)*(h-pad*2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const up = slice[slice.length-1] >= slice[0];
  const color = up ? 'var(--long)' : 'var(--short)';
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

function fibBarHTML(fibData, price){
  if(!fibData) return '<div class="section-label">Fibonacci</div><div style="color:var(--ink-faint); font-family:var(--mono); font-size:11px;">No clean swing detected yet</div>';
  const {levels, swingHighPrice, swingLowPrice} = fibData;
  const span = swingHighPrice - swingLowPrice || 1;
  const pos = v => ((v-swingLowPrice)/span)*100;
  let html = '<div class="section-label">Fibonacci Zone (last swing)</div><div class="fibbar">';
  levels.forEach(lv=>{
    const leftPct = pos(lv.price);
    html += `<div class="fibline" style="left:${leftPct}%"><span class="lbl">${lv.ratio===0?'0':lv.ratio===1?'1':lv.ratio}</span></div>`;
  });
  const pricePct = Math.max(0,Math.min(100,pos(price)));
  html += `<div class="fibmarker" style="left:${pricePct}%"></div>`;
  html += '</div>';
  return html;
}

function bbBarHTML(bbVal, price){
  if(!bbVal) return '';
  const width = (bbVal.upper-bbVal.lower) || 1;
  const pct = Math.max(0, Math.min(100, ((price-bbVal.lower)/width)*100));
  return `
    <div class="section-label">Bollinger Bands (20, 2σ)</div>
    <div class="bbbar"><div class="bbmarker" style="left:${pct}%"></div></div>
    <div class="bblabels"><span>${fmtPrice(bbVal.lower)}</span><span>mid ${fmtPrice(bbVal.mid)}</span><span>${fmtPrice(bbVal.upper)}</span></div>
  `;
}

function indicatorGridHTML(data){
  const rsiVal = data.rsiVal;
  const rsiClass = rsiVal==null ? '' : rsiVal>=70 ? 'neg' : rsiVal<=30 ? 'pos' : '';
  const rsiZone = rsiVal==null ? '—' : rsiVal>=70 ? 'Overbought' : rsiVal<=30 ? 'Oversold' : 'Neutral';
  const rsiPct = rsiVal==null ? 0 : Math.max(0,Math.min(100,rsiVal));

  const hist = data.macdHist;
  const histClass = hist==null ? '' : hist>0 ? 'pos' : 'neg';
  const crossed = data.macdHistPrev!=null && hist!=null && Math.sign(data.macdHistPrev)!==Math.sign(hist);

  const vol = data.vol;
  const volClass = vol.ratio>1.5 ? 'warn' : vol.ratio<0.5 ? '' : '';

  return `
  <div class="ind-grid">
    <div class="ind-card">
      <div class="lbl"><span>RSI (14)</span><span>${rsiZone}</span></div>
      <div class="val ${rsiClass}">${rsiVal==null?'—':rsiVal.toFixed(1)}</div>
      <div class="rangebar"><div class="fill" style="width:${rsiPct}%"></div></div>
    </div>
    <div class="ind-card">
      <div class="lbl"><span>MACD Hist</span><span>${crossed?'fresh cross':''}</span></div>
      <div class="val ${histClass}">${hist==null?'—':hist>0?'+':''}${hist==null?'':fmtPrice(hist)}</div>
      <div class="mini">signal ${hist==null?'—':(hist>0?'bullish':'bearish')} momentum</div>
    </div>
    <div class="ind-card">
      <div class="lbl"><span>Volume</span><span>vs 20-avg</span></div>
      <div class="val ${volClass}">${vol.ratio.toFixed(2)}×</div>
      <div class="mini">${vol.ratio>1.5?'spike':vol.ratio<0.5?'thin':'normal'}</div>
    </div>
    <div class="ind-card">
      <div class="lbl"><span>ATR (14)</span><span>volatility</span></div>
      <div class="val">${fmtPrice(data.currentATR)}</div>
      <div class="mini">${((data.currentATR/data.price)*100).toFixed(2)}% of price</div>
    </div>
  </div>`;
}

function levelsHTML(levels){
  return `
  <div class="section-label">Key Levels</div>
  <div class="levels-row">
    <div class="level-box sup"><div class="lbl">Support</div><div class="val">${levels.support?fmtPrice(levels.support):'—'}</div></div>
    <div class="level-box res"><div class="lbl">Resistance</div><div class="val">${levels.resistance?fmtPrice(levels.resistance):'—'}</div></div>
  </div>`;
}

function renderPanel(elId, data){
  const el = document.getElementById(elId);
  if(!el) return;
  const dirLabel = data.direction.toUpperCase();
  const badgeClass = data.direction==='long'?'long':data.direction==='short'?'short':'neutral';

  let stopRow = '';
  if(data.stopPrice){
    stopRow = `
      <tr><td>Entry (last close)</td><td>${fmtPrice(data.price)}</td></tr>
      <tr><td>Stop Loss</td><td class="hl-short">${fmtPrice(data.stopPrice)}</td></tr>
      <tr><td>Stop Distance</td><td class="hl-gold">${data.stopDistPct.toFixed(2)}%</td></tr>
    `;
  } else {
    stopRow = `
      <tr><td>Last Price</td><td>${fmtPrice(data.price)}</td></tr>
      <tr><td>Status</td><td style="color:var(--ink-faint)">No qualifying setup</td></tr>
    `;
  }

  const patternTags = data.patterns.length
    ? data.patterns.map(p=>`<span class="tag ${p.dir===1?'hit-long':'hit-short'}">${p.name}</span>`).join('')
    : '<span class="tag">No pattern at last candle</span>';

  const fibTag = data.fibHitLevel
    ? `<span class="tag hit">Price at ${data.fibHitLevel.ratio} retracement</span>`
    : `<span class="tag">Not at a key fib level</span>`;

  const trendTag = `<span class="tag ${data.trend.dir!=='neutral'?'hit':''}">Trend: ${data.trend.dir}</span>`;

  el.innerHTML = `
    <div class="signal-row">
      <span class="signal-badge ${badgeClass}">${dirLabel}</span>
      <span class="signal-score">confluence <b>${data.score}</b>/100</span>
    </div>
    <div class="gauge-wrap">
      <div class="gauge">${gaugeSVG(data.score, data.direction)}</div>
      <div class="gauge-text">
        <span class="n">${data.score}</span>
        trend + fib + pattern + RSI + MACD + BB + volume
      </div>
    </div>
    ${indicatorGridHTML(data)}
    ${fibBarHTML(data.fibData, data.price)}
    ${bbBarHTML(data.bbVal, data.price)}
    ${levelsHTML(data.levels)}
    <div class="section-label">Signals detected</div>
    <div class="tags">${trendTag}${fibTag}${patternTags}</div>
    <div class="section-label">Trade Parameters</div>
    <table class="datatable">${stopRow}</table>
  `;
}

function renderHero(resultsByTf){
  const el = document.getElementById('heroCard');
  if(!el) return;
  let weightedScore = 0, weightSum = 0, longVotes = 0, shortVotes = 0;
  TIMEFRAMES.forEach(tf=>{
    const d = resultsByTf[tf.key];
    if(!d) return;
    weightedScore += d.score * tf.weight;
    weightSum += tf.weight;
    if(d.direction==='long') longVotes++;
    else if(d.direction==='short') shortVotes++;
  });
  const avgScore = weightSum ? Math.round(weightedScore/weightSum) : 0;
  let overall = 'neutral';
  if(longVotes>shortVotes && longVotes>=1 && avgScore>=45) overall = 'long';
  else if(shortVotes>longVotes && shortVotes>=1 && avgScore>=45) overall = 'short';

  const votePills = TIMEFRAMES.map(tf=>{
    const d = resultsByTf[tf.key];
    const cls = d ? d.direction : 'neutral';
    return `<span class="vote-pill ${cls}">${tf.label}: ${d?d.direction.toUpperCase():'—'} (${d?d.score:'—'})</span>`;
  }).join('');

  el.innerHTML = `
    <div class="hero-badge ${overall}">${overall.toUpperCase()}<small>weighted ${avgScore}/100</small></div>
    <div class="hero-text">
      <h3>Overall Bias — 15m / 1h / 1d combined</h3>
      <p>${longVotes} of ${TIMEFRAMES.length} timeframes lean long, ${shortVotes} lean short. Weighted toward higher timeframes (1D counts most, 15m least). Use this as context, not a standalone trigger — check each panel below before acting.</p>
    </div>
    <div class="hero-votes">${votePills}</div>
  `;
}

/* ---------------- fetch & orchestrate ---------------- */
function buildSymbolBar(){
  const bar = document.getElementById('symbolbar');
  if(!bar) return;
  const frag = document.createDocumentFragment();
  SYMBOLS.forEach(sym=>{
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.dataset.sym = sym;
    btn.textContent = sym.replace('USDT','');
    frag.appendChild(btn);
  });
  bar.insertBefore(frag, bar.querySelector('.custom-sym'));
}

async function loadSymbol(symbol){
  currentSymbol = symbol;
  const statusEl = document.getElementById('statusLine');
  statusEl.className = 'status';
  statusEl.innerHTML = `<span class="loading-pulse"></span> loading ${symbol} across 15m / 1h / 1d…`;
  document.querySelectorAll('.chip[data-sym]').forEach(c=>{
    c.classList.toggle('active', c.dataset.sym===symbol);
  });

  try{
    const fetches = TIMEFRAMES.map(tf =>
      fetch(`${API}?symbol=${symbol}&interval=${tf.interval}&limit=300`)
        .then(r=>{ if(!r.ok) throw new Error('bad symbol or network'); return r.json(); })
    );
    const tickerFetch = fetch(`${TICKER_API}?symbol=${symbol}`).then(r=>r.json());

    const [rawResults, ticker] = await Promise.all([Promise.all(fetches), tickerFetch]);

    const resultsByTf = {};
    TIMEFRAMES.forEach((tf, idx)=>{
      resultsByTf[tf.key] = analyze(rawResults[idx]);
    });

    const priceData = resultsByTf['15m'];
    document.getElementById('pxVal').textContent = fmtPrice(priceData.price);
    document.getElementById('pxSym').textContent = symbol;
    document.getElementById('pxSpark').innerHTML = sparklineSVG(priceData.closes);
    const chgPct = parseFloat(ticker.priceChangePercent || 0);
    const chgEl = document.getElementById('pxChg');
    chgEl.textContent = (chgPct>=0?'+':'') + chgPct.toFixed(2) + '% 24h';
    chgEl.className = 'chg ' + (chgPct>=0?'up':'down');

    renderHero(resultsByTf);
    TIMEFRAMES.forEach(tf=>{
      renderPanel('panel-'+tf.key, resultsByTf[tf.key]);
    });

    statusEl.textContent = `live — updated ${new Date().toLocaleTimeString()} — refreshes every 30s`;
  } catch(err){
    statusEl.className = 'status err';
    statusEl.textContent = `couldn't load ${symbol}: ${err.message}. Check the symbol is a valid Binance pair (e.g. BTCUSDT).`;
  }
}

function init(){
  buildSymbolBar();
  document.getElementById('symbolbar').addEventListener('click', e=>{
    const btn = e.target.closest('.chip[data-sym]');
    if(btn) loadSymbol(btn.dataset.sym);
  });
  document.getElementById('customGo').addEventListener('click', ()=>{
    const v = document.getElementById('customInput').value.trim().toUpperCase();
    if(v) loadSymbol(v);
  });
  document.getElementById('customInput').addEventListener('keydown', e=>{
    if(e.key==='Enter') document.getElementById('customGo').click();
  });

  loadSymbol(currentSymbol);
  setInterval(()=>loadSymbol(currentSymbol), 30000);
}

document.addEventListener('DOMContentLoaded', init);
