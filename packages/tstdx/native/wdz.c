/* WDZ 0x105 compact bars -> legacy-compatible CSV / LC5. No CRT or allocation.
 * Container MD5/zlib use Node's native libraries; XOR and all per-bar work live here.
 * Return codes: -1 truncated, -2 unsupported/invalid, -3 capacity, -7 source-time conflict.
 */
typedef unsigned char byte;
typedef unsigned int u32;
typedef unsigned long long u64;
int _fltused=0;
static u32 le16(const byte *p) { return p[0] | ((u32)p[1]<<8); }
static u32 le32(const byte *p) { return le16(p) | (le16(p+2)<<16); }
static float real(const byte *p) { union { u32 u; float f; } v; v.u=le32(p); return v.f; }
static int valid(float f) { return f>=0 && f<1.0e25f; }
__declspec(dllexport) void wdz_xor(byte *p, u32 size, const byte *key) {
    for(u32 i=0;i<size;i++) p[i]^=key[i&127];
}
static byte *digits(byte *p, u64 n, int width) {
    byte buf[32]; int size=0;
    do { buf[size++]=(byte)('0'+n%10); n/=10; } while(n);
    while(size<width) buf[size++]='0';
    while(size) *p++=buf[--size];
    return p;
}
/* VB Single -> decimal rounds half up to seven significant digits before Format. */
static double legacy(float v) {
    double d=v, unit=1, x=d;
    int exponent=0;
    if(x) { while(x>=10) {x/=10;exponent++;} while(x<1) {x*=10;exponent--;} }
    int shift=exponent-6;
    if(shift>=0) { for(int i=0;i<shift;i++)unit*=10; d=(u64)(d/unit+0.5)*unit; }
    else { for(int i=0;i>shift;i--)unit*=10; d=(double)(u64)(d*unit+0.5)/unit; }
    return d;
}
static double rounded(float v, int places) {
    u64 factor=places==3?1000:places==2?100:1;
    return (double)(u64)(legacy(v)*factor+0.5)/factor;
}
static byte *number(byte *p, float v, int places) {
    double d=legacy(v);
    u64 factor=places==3?1000:places==2?100:1;
    u64 value=(u64)(d*factor+0.5);
    p=digits(p,value/factor,1);
    if(places) { *p++='.';p=digits(p,value%factor,places); }
    return p;
}
static void civil(u32 stamp, int *year, int *mon, int *dom) {
    /* Gregorian civil date from Unix days (timestamps are naive UTC in this format). */
    int z=(int)(stamp/86400)+719468;
    int era=z/146097, doe=z-era*146097;
    int yoe=(doe-doe/1460+doe/36524-doe/146096)/365;
    int y=yoe+era*400, doy=doe-(365*yoe+yoe/4-yoe/100);
    int mp=(5*doy+2)/153, day=doy-(153*mp+2)/5+1;
    int month=mp+(mp<10?3:-9); y+=month<=2;
    *year=y;*mon=month;*dom=day;
}
static byte *date(byte *p, u32 stamp) {
    int y,month,day;civil(stamp,&y,&month,&day);
    p=digits(p,y,4);*p++='-';p=digits(p,month,2);*p++='-';p=digits(p,day,2);
    *p++=' ';p=digits(p,stamp/3600%24,2);*p++=':';p=digits(p,stamp/60%60,2);
    *p++=':';return digits(p,stamp%60,2);
}
#define NEED(n) if((u32)(end-p)<(u32)(n)) return -1
static void put16(byte *p,u32 n) {p[0]=(byte)n;p[1]=(byte)(n>>8);}
static void put32(byte *p,u32 n) {put16(p,n);put16(p+2,n>>16);}
static void putfloat(byte *p,double d) {union {float f;u32 u;} v;v.f=(float)d;put32(p,v.u);}
static u64 order(const byte *p,int reference) {
    u32 packed=le16(p);int y=2004+(packed>>11);while(y>reference+1)y-=32;
    return ((u64)y*10000+(packed&2047))*1440+le16(p+2);
}
static void swap(byte *data,u32 *overflow,u32 *sourceAmounts,u32 a,u32 b) {
    for(int j=0;j<32;j++){byte x=data[a*32+j];data[a*32+j]=data[b*32+j];data[b*32+j]=x;}
    u32 x=overflow[a];overflow[a]=overflow[b];overflow[b]=x;
    x=sourceAmounts[a];sourceAmounts[a]=sourceAmounts[b];sourceAmounts[b]=x;
}
static void sift(byte *data,u32 *overflow,u32 *sourceAmounts,u32 count,u32 root,int reference) {
    while(root<count/2) {
        u32 child=root*2+1;
        if(child+1<count && order(data+child*32,reference)<order(data+(child+1)*32,reference))child++;
        if(order(data+root*32,reference)>=order(data+child*32,reference))return;
        swap(data,overflow,sourceAmounts,root,child);root=child;
    }
}
static int normalize(byte *data,u32 *overflow,u32 *sourceAmounts,u32 *count,int sort,int reference,u32 *legacyOut,int common) {
    if(sort) {
        for(u32 i=*count/2;i>0;i--)sift(data,overflow,sourceAmounts,*count,i-1,reference);
        for(u32 n=*count;n>1;n--){swap(data,overflow,sourceAmounts,0,n-1);sift(data,overflow,sourceAmounts,n-1,0,reference);}
    }
    u32 written=0;
    for(u32 i=0;i<*count;i++) {
        if(written && le32(data+i*32)==le32(data+(written-1)*32)) {
            for(int j=0;j<32;j++)if(data[i*32+j]!=data[(written-1)*32+j])return -7;
            continue;
        }
        if(i!=written) {for(int j=0;j<32;j++)data[written*32+j]=data[i*32+j];overflow[written]=overflow[i];sourceAmounts[written]=sourceAmounts[i];}
        written++;
    }
    for(u32 i=0;i<written;i++) {
        double raw=rounded(real(data+i*32+28),0),old=raw*100;
        legacyOut[i]=old>=2147483648.0?0:(u32)old;
        put32(data+i*32+28,0);
    }
    *count=written;return (int)(written*32);
}
/* Match the amount-implied average price only when exactly one unit fits. */
static double volume_value(double raw,double amount,double low,double high,int policy) {
    if(policy==1)return raw;
    double factor=policy==2?1:100,tolerance=0.001+high*0.000001;
    if(raw>0 && amount>0) {
        const double factors[3]={100,1,0.01};int matches=0;double chosen=factor;
        for(int i=0;i<3;i++) {
            double price=amount/(raw*factors[i]);
            if(price>=low-tolerance && price<=high+tolerance){matches++;chosen=factors[i];}
        }
        if(matches==1)factor=chosen;
    }
    return (double)(u64)(raw*factor+0.5);
}
static int decode(const byte *data, u32 size, byte *out, u32 cap, u32 *count,
    int lc5,int common,int reference,u32 *overflow,u32 *skipped,u32 *legacyOut,u32 *sourceAmounts) {
    const byte *p=data,*end=data+size;
    byte *q=out; u32 stamp=0,previous=0;int needsSort=0;
    const char *header="Date,Open,Low,High,Close,Volume,Amount\r\n";
    if(cap<40)return -3;
    if(!lc5)while(*header)*q++=*header++;
    *count=0;
    if(lc5)count[1]=0;
    while(p<end) {
        if(cap-(u32)(q-out)<(lc5?32u:256u))return -3;
        u32 flags=*p++,base=0;
        if(flags&128) { NEED(1);u32 step=60 * *p++;if(stamp>0xffffffffu-step)return -2;stamp+=step; }
        else { NEED(4);stamp=le32(p);p+=4; }
        if(!lc5 && (stamp<631152000u || stamp>4102444799u))return -2;
        u32 mode=(flags>>5)&3,scale=mode==1?100:mode==2?1000:10000;
        float low,op,hi,cl,vol,amt;
        if(!mode) { NEED(16);low=real(p);op=real(p+4);hi=real(p+8);cl=real(p+12);p+=16; }
        else {
            if(flags&1) {NEED(2);base=le16(p);p+=2;low=(float)((double)base/scale);}
            else {
                NEED(4);low=real(p);p+=4;if(!valid(low) || (double)low*scale>2147483646)return -2;
                double value=(double)low*scale; base=(u32)value;
                double fract=value-base;if(fract>0.5 || (fract==0.5 && (base&1)))base++;
            }
            NEED(3);op=(float)((double)(base+p[0])/scale);hi=(float)((double)(base+p[1])/scale);
            cl=(float)((double)(base+p[2])/scale);p+=3;
        }
        switch(flags&24) {
            case 0: NEED(4);vol=real(p);p+=4;break;
            case 8: NEED(1);vol=*p++;break;
            case 16: NEED(2);vol=(float)le16(p);p+=2;break;
            default:return -2;
        }
        if(flags&4) {if(!mode)return -2;NEED(2);amt=(float)((double)vol*base+le16(p));p+=2;}
        else {NEED(4);amt=real(p);p+=4;}
        if(!(flags&2)) {NEED(4);p+=4;}
        if(!valid(low)||!valid(op)||!valid(hi)||!valid(cl)||!valid(vol)||!valid(amt))return -2;
        /* Bounds also protect conversion to uint64 during decimal formatting. */
        if(op>1e12f||low>1e12f||hi>1e12f||cl>1e12f||vol>1e15f||amt>1e16f)return -2;
        if(lc5) {
            /* Source placeholders carry no market observation. Keep their times in the report. */
            if(low==0 && op==0 && hi==0 && cl==0 && vol==0 && amt==0) {
                skipped[count[1]++]=stamp;continue;
            }
            int y,m,d;civil(stamp,&y,&m,&d);
            int encodedYear=2004+((y-2004)&31);while(encodedYear>reference+1)encodedYear-=32;
            if(stamp<631152000u || stamp>4102444799u || encodedYear!=y || y>reference+1 || stamp%300) {
                skipped[count[1]++]=stamp;continue;
            }
            double o=rounded(op,3),h=rounded(hi,3),l=rounded(low,3),c=rounded(cl,3);
            if(l<=0 || l>o || l>c || h<o || h<c) {skipped[count[1]++]=stamp;continue;}
            double raw=rounded(vol,0),amount=rounded(amt,2);
            double volume=volume_value(raw,amount,l,h,common&7);
            if(volume>9007199254740991.0)return -2;
            int over=volume>4294967295.0;
            put16(q,(((y-2004)&31)<<11)+m*100+d);put16(q+2,stamp/60%1440);
            putfloat(q+4,o);putfloat(q+8,h);putfloat(q+12,l);putfloat(q+16,c);putfloat(q+20,rounded(amt,2));
            /* Keep the exact source Single separately from CSV-compatible amount.
             * This proves identity with original binary histories without tolerance. */
            union {float f;u32 u;} sourceAmount;sourceAmount.f=amt;
            sourceAmounts[*count]=sourceAmount.u;
            put32(q+24,over?0:(u32)volume);putfloat(q+28,rounded(vol,0));
            if(stamp<previous)needsSort=1;
            previous=stamp;
            overflow[*count]=over?stamp:0;
            q+=32;
        } else {
            q=date(q,stamp);*q++=',';q=number(q,op,3);*q++=',';q=number(q,low,3);
            *q++=',';q=number(q,hi,3);*q++=',';q=number(q,cl,3);*q++=',';q=number(q,vol,0);
            *q++=',';q=number(q,amt,2);*q++='\r';*q++='\n';
        }
        (*count)++;
    }
    return lc5?normalize(out,overflow,sourceAmounts,count,needsSort,reference,legacyOut,common):(int)(q-out);
}
__declspec(dllexport) int wdz_csv(const byte *data,u32 size,byte *out,u32 cap,u32 *count) {
    return decode(data,size,out,cap,count,0,0,0,0,0,0,0);
}
__declspec(dllexport) int wdz_lc5(const byte *data,u32 size,byte *out,u32 cap,u32 *count,
    int common,int reference,u32 *overflow,u32 *skipped,u32 *legacyOut,u32 *sourceAmounts) {
    return decode(data,size,out,cap,count,1,common,reference,overflow,skipped,legacyOut,sourceAmounts);
}
