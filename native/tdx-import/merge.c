/* Fixed-size LC5 merge. No CRT allocation or per-record strings. */
typedef unsigned char byte;
typedef unsigned int u32;
typedef unsigned long long u64;
static u32 word(const byte *p) { return p[0] | ((u32)p[1] << 8); }
static u64 key(const byte *p, int reference) {
    u32 date = word(p), md = date & 2047, minutes = word(p + 2);
    int year = 2004 + (date >> 11);
    while (year > reference + 1) year -= 32;
    u32 month = md / 100, day = md % 100;
    int leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    const int days[12] = {31,28,31,30,31,30,31,31,30,31,30,31};
    if (year < 1990 || month < 1 || month > 12 || day < 1 ||
        day > (u32)(days[month-1] + (month == 2 && leap)) || minutes >= 1440) return 0;
    return ((u64)year * 10000 + md) * 1440 + minutes;
}
static void copy(byte *to, const byte *from) { for (int i=0;i<32;i++) to[i]=from[i]; }
static u32 volume(const byte *p) { return word(p+24) | (word(p+26)<<16); }
static int repairable(const byte *old,const byte *incoming,u32 legacy,const byte *sourceAmount) {
    if(volume(old)==volume(incoming))return 0;
    /* A source-confirmed missing volume can also be recovered independently
     * of which historical exporter originally wrote the zero. */
    if(volume(old)!=legacy && volume(old)!=0)return 0;
    for(int i=0;i<20;i++)if(old[i]!=incoming[i])return 0;
    int sameAmount=1;for(int i=20;i<24;i++)if(old[i]!=incoming[i])sameAmount=0;
    if(sameAmount)return 1;
    /* Only a zero can use the alternative exact source amount representation.
     * No relative tolerance and no change to the existing amount. */
    if(volume(old) || !sourceAmount)return 0;
    for(int i=0;i<4;i++)if(old[20+i]!=sourceAmount[i])return 0;
    return 1;
}
/* Compare source identity and exact legacy volume before changing only bytes 24..27. */
__declspec(dllexport) int lc5_repair_volumes(byte *old,u32 oldCount,
    const byte *incoming,u32 count,const u32 *legacy,int reference,const byte *sourceAmounts) {
    u32 a=0,b=0;int repaired=0;
    /* Validate both histories before making any in-memory change. */
    u64 previous=0;
    for(u32 i=0;i<oldCount;i++){u64 k=key(old+i*32,reference);if(!k || k<=previous)return -1;previous=k;}
    previous=0;
    for(u32 i=0;i<count;i++){u64 k=key(incoming+i*32,reference);if(!k || k<=previous)return -1;previous=k;}
    while(a<oldCount && b<count) {
        u64 ka=key(old+a*32,reference),kb=key(incoming+b*32,reference);
        if(ka<kb){a++;continue;}if(kb<ka){b++;continue;}
        if(repairable(old+a*32,incoming+b*32,legacy[b],sourceAmounts?sourceAmounts+b*4:0)) {
            for(int j=24;j<28;j++)old[a*32+j]=incoming[b*32+j];repaired++;
        }
        a++;b++;
    }
    return repaired;
}
/* stats: added, identical, conflicts. Negative result means no output may be written. */
__declspec(dllexport) int lc5_merge(const byte *old, u32 oldCount,
    const byte *incoming, u32 count, byte *out, u32 *stats, int reference) {
    u64 previous = 0;
    for (u32 i=0;i<oldCount;i++) {
        u64 current = key(old+i*32, reference);
        if (!current || current <= previous) return -1;
        previous = current;
    }
    previous = 0;
    for (u32 i=0;i<count;i++) {
        u64 current = key(incoming+i*32, reference);
        if (!current || current <= previous) return -2;
        previous = current;
    }
    u32 a=0,b=0,n=0;
    stats[0]=stats[1]=stats[2]=0;
    while (a<oldCount || b<count) {
        u64 ka=a<oldCount?key(old+a*32,reference):~(u64)0;
        u64 kb=b<count?key(incoming+b*32,reference):~(u64)0;
        if (ka<kb) copy(out+(n++)*32,old+(a++)*32);
        else if (kb<ka) { copy(out+(n++)*32,incoming+(b++)*32);stats[0]++; }
        else {
            int same=1; for(int j=0;j<28;j++) if(old[a*32+j]!=incoming[b*32+j]) same=0;
            stats[same?1:2]++;copy(out+(n++)*32,old+(a++)*32);b++;
        }
    }
    return (int)n;
}
