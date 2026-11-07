/* Mapped range comparison with optional volume-only repair. Uses the merge key contract. */
#include "merge.c"
__declspec(dllexport) int lc5_probe(byte *old,u32 oldCount,const byte *incoming,
    u32 count,u32 *stats,int reference,const u32 *legacy,int repair,const byte *sourceAmounts) {
    stats[0]=stats[1]=stats[2]=0;
    if(!count)return 1;
    u64 first=key(incoming,reference),previous=0;
    if(!first)return -1;
    u32 lo=0,hi=oldCount;
    while(lo<hi) {
        u32 mid=lo+(hi-lo)/2;u64 k=key(old+mid*32,reference);
        if(!k)return -1;
        if(k<first)lo=mid+1;else hi=mid;
    }
    u32 a=lo;
    for(u32 b=0;b<count;b++) {
        u64 kb=key(incoming+b*32,reference);
        if(!kb || kb<=previous)return -1;
        previous=kb;
        while(a<oldCount) {
            u64 ka=key(old+a*32,reference);
            if(!ka)return -1;
            if(a && key(old+(a-1)*32,reference)>=ka)return -1;
            if(ka>kb)return 0;
            if(ka==kb)break;
            a++;
        }
        if(a==oldCount)return 0;
        int same=1;for(int j=0;j<28;j++)if(old[a*32+j]!=incoming[b*32+j])same=0;
        if(legacy && repairable(old+a*32,incoming+b*32,legacy[b],sourceAmounts?sourceAmounts+b*4:0))stats[2]++;
        stats[same?0:1]++;a++;
    }
    /* The entire incoming range is present and validated before the first write.
     * Only matching volume words change; no whole-history copy or rewrite. */
    if(repair && legacy && stats[2]) {
        a=lo;
        for(u32 b=0;b<count;b++) {
            u64 kb=key(incoming+b*32,reference);
            while(key(old+a*32,reference)<kb)a++;
            if(repairable(old+a*32,incoming+b*32,legacy[b],sourceAmounts?sourceAmounts+b*4:0)) {
                for(int j=24;j<28;j++)old[a*32+j]=incoming[b*32+j];
                int same=1;for(int j=0;j<24;j++)if(old[a*32+j]!=incoming[b*32+j])same=0;
                if(same){stats[0]++;stats[1]--;}
            }
            a++;
        }
    }
    return 1;
}
