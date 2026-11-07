/* Read-only audit of every LC5 record, including history outside the WDZ ranges. */
#include "merge.c"
int _fltused=0;
/* Source-confirmed packed timestamps are sorted numerically for binary lookup. */
static u32 bits(const byte *p) { return word(p) | (word(p+2)<<16); }
static float price(const byte *p) {union {u32 u;float f;} v;v.u=bits(p);return v.f;}
static int finite(const byte *p) {return (bits(p)&0x7f800000u)!=0x7f800000u;}
/* stats: records, bad dates, non-increasing times, bad OHLC, bad amounts,
 * positive-amount/zero-volume, examples. examples are [record index, flags]. */
__declspec(dllexport) void lc5_audit(const byte *data,u32 count,u32 *stats,
    u32 *examples,u32 capacity,int reference) {
    for(int i=0;i<7;i++)stats[i]=0;
    stats[0]=count;u64 previous=0;
    for(u32 i=0;i<count;i++) {
        const byte *p=data+i*32;u32 flags=0;u64 k=key(p,reference);
        if(!k){stats[1]++;flags|=1;}
        if(k && previous && k<=previous){stats[2]++;flags|=2;}
        previous=k;
        float o=price(p+4),h=price(p+8),l=price(p+12),c=price(p+16);
        if(!finite(p+4)||!finite(p+8)||!finite(p+12)||!finite(p+16)||
            l<=0||l>o||l>c||h<o||h<c){stats[3]++;flags|=4;}
        if(!finite(p+20)||price(p+20)<0){stats[4]++;flags|=8;}
        if(volume(p)==0 && finite(p+20) && price(p+20)>0){stats[5]++;flags|=16;}
        if(flags && stats[6]<capacity){u32 n=stats[6]++;examples[n*2]=i;examples[n*2+1]=flags;}
    }
}
__declspec(dllexport) int lc5_remove_zero_prices(const byte *data,u32 count,
    byte *out,const u32 *allowed,u32 allowedCount) {
    u32 written=0;
    for(u32 i=0;i<count;i++) {
        const byte *p=data+i*32;int zero=1;
        for(int j=4;j<20;j+=4)if(price(p+j)!=0)zero=0;
        if(zero) {
            u32 k=bits(p),lo=0,hi=allowedCount;
            while(lo<hi){u32 mid=lo+(hi-lo)/2;if(allowed[mid]<k)lo=mid+1;else hi=mid;}
            if(lo<allowedCount && allowed[lo]==k)continue;
        }
        copy(out+written*32,p);written++;
    }
    return (int)written;
}
