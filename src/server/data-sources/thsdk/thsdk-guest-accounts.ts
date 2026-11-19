import { randomInt } from "node:crypto";

export type ThsdkGuestAccount = {
  username: string;
  password: string;
  mac: string;
};

/**
 * Frozen copy of the temporary accounts bundled with thsdk 2.0.2
 * (`thsdk/_temporary_accounts.py`, prefix `thsguest_`). They are official
 * short-lived evaluation accounts; never log or expose them.
 */
const guestAccounts: readonly ThsdkGuestAccount[] = [
  {
    username: "thsguest_n35365t7",
    password: "29e9075556b7bcee6ecbc1e31e3d9bc6",
    mac: "1a:6e:20:a4:6e:2d",
  },
  {
    username: "thsguest_bqjbsllb",
    password: "f56c6a37055c326a578560b08df566fd",
    mac: "aa:d0:98:7b:b3:72",
  },
  {
    username: "thsguest_0a7mzp30",
    password: "7dfe8790d60753fb494513923423ec41",
    mac: "ce:75:ca:83:b8:2b",
  },
  {
    username: "thsguest_c3olb9gc",
    password: "f312b28edea08673946c8f56abd6bf5a",
    mac: "be:76:8e:b8:44:60",
  },
  {
    username: "thsguest_dv4u6hvp",
    password: "2dbba40ca63fef29bf3e6e6e151ae372",
    mac: "f6:0f:3f:21:36:3c",
  },
  {
    username: "thsguest_wp5sv42z",
    password: "93836975f5a34c2eff4cab58f3c38403",
    mac: "4e:7e:41:2d:b2:37",
  },
  {
    username: "thsguest_wziz9v4n",
    password: "a82f6ff964fc44c521cc6b64812c8302",
    mac: "b6:13:49:9c:bf:51",
  },
  {
    username: "thsguest_kj01qfgv",
    password: "6d014d319b3d77226c6b71ffeeec6874",
    mac: "da:a0:f7:b6:1e:59",
  },
  {
    username: "thsguest_6au8e9b5",
    password: "84d4fdb63f6a695807f0d1a84237a8f5",
    mac: "12:88:f0:c6:a2:a8",
  },
  {
    username: "thsguest_9n9wjhvo",
    password: "db484794d4c4cc8911ea3bae4d453b43",
    mac: "56:9e:7a:fb:4a:0f",
  },
  {
    username: "thsguest_kw5m3tki",
    password: "18740ee6393757bd859365d0dd5dbe38",
    mac: "ca:e8:b7:f7:be:da",
  },
  {
    username: "thsguest_ej3ehnvi",
    password: "3f153b438c57708820d132617c7610a3",
    mac: "be:30:03:ed:19:fc",
  },
  {
    username: "thsguest_k8wv0s2f",
    password: "95e0a73c13fe014e75a149ea3502fcb2",
    mac: "32:35:74:d7:8a:64",
  },
  {
    username: "thsguest_d65x5hzv",
    password: "4a8c784f9840f6bc4876e496aac2fa43",
    mac: "62:0c:6f:fd:b0:da",
  },
  {
    username: "thsguest_k5tyyg1f",
    password: "e0ae1f8471ed15edaec9536a72d59ed9",
    mac: "76:86:d3:50:11:64",
  },
  {
    username: "thsguest_u2erkssi",
    password: "9b1ee153efc91dccd04ea0b7263273bc",
    mac: "da:5b:41:37:50:a9",
  },
  {
    username: "thsguest_pqz6sv2x",
    password: "78d657f72e6b49cb455f54ed1dd57d46",
    mac: "ce:19:82:e9:23:07",
  },
  {
    username: "thsguest_app4n2nm",
    password: "f9de1e9bf13021649193e34b53045423",
    mac: "7a:4b:bd:f3:0e:3d",
  },
  {
    username: "thsguest_t529muay",
    password: "95d5de6a62567a5d45c7b25813d9cbda",
    mac: "2a:2c:c6:ef:61:80",
  },
  {
    username: "thsguest_1ssvi1v1",
    password: "98de0199e3f6de67598534910b64d8c6",
    mac: "9e:ad:c1:2f:54:6b",
  },
  {
    username: "thsguest_6hzj3cfa",
    password: "6f89aa71eaa65a7cb495352f0a0e7143",
    mac: "8a:39:95:e0:02:b9",
  },
  {
    username: "thsguest_oimmqml7",
    password: "d568efbec2021c42c7eda067991e6b32",
    mac: "96:9c:6c:74:e3:3a",
  },
  {
    username: "thsguest_kh04ek6q",
    password: "309caa162d3c27f199708fa441ecd9ad",
    mac: "32:5e:d2:e2:d8:9f",
  },
  {
    username: "thsguest_pw05sieq",
    password: "fe66dd87a8eae670beac40c392d1db92",
    mac: "a2:19:96:31:aa:28",
  },
  {
    username: "thsguest_bk278v3f",
    password: "9d6ea7614482cee9729d46854226b922",
    mac: "9e:01:9f:da:66:1b",
  },
  {
    username: "thsguest_janrnkle",
    password: "4849fd68536c76c878c38322c41cca22",
    mac: "d2:df:c5:04:58:0f",
  },
  {
    username: "thsguest_i4bxskin",
    password: "bb8f3baff00ff7e1ba86aa3eb97a1e30",
    mac: "2e:60:90:c2:73:f6",
  },
  {
    username: "thsguest_jdburol4",
    password: "97e04fb49f10b5bc69706c8bba8446f7",
    mac: "2a:fd:6e:37:b1:8f",
  },
  {
    username: "thsguest_9nlfe5k2",
    password: "efc8397212a8fe81c5a33fa6c9abf129",
    mac: "5a:ca:57:da:9f:6e",
  },
  {
    username: "thsguest_n7g33cl2",
    password: "83900f0cbee955c90ea9d9e13f7826a1",
    mac: "3e:0e:02:d7:22:0f",
  },
  {
    username: "thsguest_mxxwrsaz",
    password: "9514c00bb7f074754e84f9b5471ac179",
    mac: "22:ee:12:08:3c:ac",
  },
  {
    username: "thsguest_h1vthg4t",
    password: "04728d0a3e05630ac90f910befadce1b",
    mac: "92:b8:41:78:f2:08",
  },
  {
    username: "thsguest_jnkp1idy",
    password: "6e3b612cc850b8f3f3d4175fd7b1f66b",
    mac: "02:03:20:e0:d4:ad",
  },
  {
    username: "thsguest_fli7o75j",
    password: "ceeae4ccf8400d0846e0120805ffdf05",
    mac: "f2:9d:22:31:ad:7c",
  },
  {
    username: "thsguest_qkjxeizl",
    password: "fc1bd7c0e3fa5ca2a2c6ebcb994f7a17",
    mac: "a2:be:8d:d5:eb:89",
  },
  {
    username: "thsguest_0xwl0aow",
    password: "c1a110795b6befc80d3cdc9806a86ce2",
    mac: "b6:8b:b1:ee:61:e3",
  },
  {
    username: "thsguest_7fe73p4d",
    password: "18c7c0e2e374aa2ab6dab0c3b0ec579a",
    mac: "4e:c1:50:4f:42:d7",
  },
  {
    username: "thsguest_biqspra8",
    password: "d288dd117a9e27e32cb8d65d4148c24a",
    mac: "86:d6:14:2f:af:5b",
  },
  {
    username: "thsguest_w6ykyu6p",
    password: "93a01039fd9a75bb1f43d48145a77dfa",
    mac: "72:c1:92:58:6a:5a",
  },
  {
    username: "thsguest_r86k0wdm",
    password: "8aaa9816a8c3b680b595aaf056bee173",
    mac: "66:5f:74:1f:9d:5e",
  },
  {
    username: "thsguest_1wlbx4cb",
    password: "b996b1e1055cb993dccb5c2265fc6c80",
    mac: "ea:32:a4:55:3c:09",
  },
  {
    username: "thsguest_iy9v7m4o",
    password: "ed4f93815286a4483c66a3f8ad681008",
    mac: "9a:ee:45:ed:61:aa",
  },
  {
    username: "thsguest_8rynr5b0",
    password: "4f26ac218142808b2969032a13c59c73",
    mac: "0a:91:eb:fe:81:42",
  },
  {
    username: "thsguest_ejpx9bmk",
    password: "cbfc2fbf859313346d144513f3903af2",
    mac: "62:bf:8c:5c:5d:2b",
  },
  {
    username: "thsguest_rxptkeeg",
    password: "e6646287ad046caec8e29a4963e92584",
    mac: "9e:e0:f2:b4:55:9c",
  },
  {
    username: "thsguest_ykrjfiep",
    password: "086c32e44a03ba13473a872da9f8fbe0",
    mac: "8a:3f:b4:39:4f:cb",
  },
  {
    username: "thsguest_yy8jdkcz",
    password: "3465e2115a7851ad8907344701b5251e",
    mac: "72:25:2a:82:b7:41",
  },
  {
    username: "thsguest_a4xrcic5",
    password: "a4564ccf016a49f087a4ba7a0af02259",
    mac: "92:a4:94:82:f0:71",
  },
  {
    username: "thsguest_fw4bsnci",
    password: "a75cd7d25f7cd483581928afa31561bc",
    mac: "1a:12:cb:ef:f8:a3",
  },
  {
    username: "thsguest_umwll2l8",
    password: "d303706ccd2c73bf18c10a62d6bde40c",
    mac: "fe:a3:15:5e:46:f2",
  },
  {
    username: "thsguest_nbvb4mm8",
    password: "a16ea5fd49e863f69541d86ecb435221",
    mac: "86:50:8f:e1:29:2b",
  },
  {
    username: "thsguest_nhhlgmko",
    password: "3a89a06d44b55f39919306dad0ddc6c6",
    mac: "0a:21:a1:57:e9:48",
  },
];

export const THSDK_GUEST_ACCOUNT_COUNT: number = guestAccounts.length;

export function pickThsdkGuestAccount(seedIndex?: number): ThsdkGuestAccount {
  const index =
    seedIndex === undefined || !Number.isFinite(seedIndex)
      ? randomInt(guestAccounts.length)
      : ((Math.trunc(seedIndex) % guestAccounts.length) +
          guestAccounts.length) %
        guestAccounts.length;
  const account = guestAccounts[index];
  if (!account) throw new Error("游客账号列表为空");
  return { ...account };
}
