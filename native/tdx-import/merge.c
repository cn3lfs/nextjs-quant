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
