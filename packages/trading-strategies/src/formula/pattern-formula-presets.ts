// Fixed, disjoint historical windows approximate the shape for formula screening.
// Native pattern geometry and CZSC labels are evaluated by their own engines.
export const patternFormulaPresets = [
  {
    name: "头肩底右肩放量突破",
    parameters: {},
    source: `LS:=REF(LLV(L,6),25);
HEADLOW:=REF(LLV(L,6),13);
RS:=REF(LLV(L,6),1);
NECK1:=REF(HHV(H,6),19);
NECK2:=REF(HHV(H,6),7);
NECK:=MAX(NECK1,NECK2);
XG:HEADLOW<MIN(LS,RS)*0.985 AND ABS(LS-RS)<=0.12*NECK AND REF(HHV(C,6),1)<=NECK AND C>NECK AND C>O AND V>1.5*REF(MA(V,20),1);`,
  },
  {
    name: "箱体平台放量突破",
    parameters: {},
    source: `TOPLINE:=REF(HHV(H,20),1);
BASELINE:=REF(LLV(L,20),1);
WIDTH:=TOPLINE-BASELINE;
TOPA:=REF(HHV(H,8),13);
TOPB:=REF(HHV(H,8),1);
BOTA:=REF(LLV(L,8),13);
BOTB:=REF(LLV(L,8),1);
XG:BETWEEN(WIDTH/BASELINE,0.03,0.18) AND MIN(TOPA,TOPB)>=TOPLINE-0.2*WIDTH AND MAX(BOTA,BOTB)<=BASELINE+0.2*WIDTH AND C>TOPLINE AND C>O AND V>1.5*REF(MA(V,20),1);`,
  },
  {
    name: "收敛三角形放量突破",
    parameters: {},
    source: `UH:=REF(HHV(H,10),11);
UL:=REF(HHV(H,10),1);
LH:=REF(LLV(L,10),11);
LL:=REF(LLV(L,10),1);
XG:UL<=UH AND LL>=LH AND UL-LL<=0.78*(UH-LH) AND C>UL AND C>O AND V>1.5*REF(MA(V,20),1);`,
  },
  {
    name: "下降楔形反转突破",
    parameters: {},
    source: `UH:=REF(HHV(H,10),11);
UL:=REF(HHV(H,10),1);
LH:=REF(LLV(L,10),11);
LL:=REF(LLV(L,10),1);
XG:UL<UH AND LL<LH AND UH-UL>LH-LL AND UL-LL<=0.78*(UH-LH) AND C>UL AND C>O AND V>1.5*REF(MA(V,20),1);`,
  },
  {
    name: "双突破趋势放量",
    parameters: {},
    source: `EARLY:=REF(HHV(H,10),11);
RECENT:=REF(HHV(H,10),1);
AGEA:=11+REF(HHVBARS(H,10),11);
AGEB:=1+REF(HHVBARS(H,10),1);
GRAD:=(RECENT-EARLY)/(AGEA-AGEB);
TREND:=RECENT+GRAD*AGEB;
LEVEL:=REF(HHV(H,5),1);
XG:GRAD<0 AND REF(C,1)<=TREND-GRAD AND C>MAX(TREND,LEVEL) AND C>O AND V>=1.5*REF(MA(V,20),1);`,
  },
  {
    name: "缠论均线吻与零轴共振突破",
    parameters: {},
    source: `FAST:=MA(C,5);
SLOW:=MA(C,10);
GAP:=FAST-SLOW;
DIF:=EMA(C,12)-EMA(C,26);
KISS:=ABS(REF(GAP,1))<=0.005*REF(SLOW,1);
XG:KISS AND GAP>MAX(0,REF(GAP,1)) AND DIF>=0 AND DIF>REF(DIF,1) AND C>REF(HHV(H,5),1) AND C>O;`,
  },
] as const;
