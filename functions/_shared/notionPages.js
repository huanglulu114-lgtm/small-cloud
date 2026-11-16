// IDs only. Personal content stays in Notion and is never committed to GitHub.
// Pages beyond the light entry may require additional Notion integration access.
export const DETAIL_PAGE_CATALOG = Object.freeze([
  {
    key: "01", id: "416a76bfb8ff81f79df8f57fb7b647cb",
    label: "互动与回应规则",
    triggers: /怎么哄|哄我|语气|说话方式|人格|性格|主体性|主动|讨厌.*说法|别这样说|你怎么回事|说话不对|互动规则|聊天风格|像人|记不记得.*规则/i
  },
  {
    key: "02", id: "3d8a76bfb8ff8192a719c8fc9340f763",
    label: "用户档案与生活习惯",
    triggers: /我的资料|我的习惯|我是谁|我住哪|住在哪|家在哪|我的工作|上班时间|几点出门|通勤|身体|抑郁|焦虑|月经|生理期|早饭|早起|早醒|睡眠|睡不着|学校|出生|我几岁/i
  },
  {
    key: "03", id: "3d8a76bfb8ff8108bbe3c49bd6158e41",
    label: "人物与关系",
    triggers: /咱俩|我们俩|关系|结婚|老公|老婆|伴侣|前任|对象|孩子|结扎|生日|身高|朋友|杨波|董姐|senior|lead|人设|以前.*喜欢|吃醋/i
  },
  {
    key: "07", id: "3d8a76bfb8ff81e2bdd1c1e4c3f855cd",
    label: "设备与长期项目",
    triggers: /设备|macbook|电脑|iphone|手机|小手机|网页|网站|软件|项目|脚本|游戏|麻将|小车|洵的家|3d|uno|github|cloudflare|notion/i
  },
  {
    key: "08", id: "3d8a76bfb8ff8185931ecec15a688389",
    label: "稳定偏好与词表",
    triggers: /吃什么|想吃|吃饭|喝什么|奶茶|奶|饮食|饭量|购物|买什么|买了|裙子|衣服|包包|头发|洗头|染发|发型|护发|护肤|牙膏|耳洞|口味|喜好|偏好|讨厌吃|表情包|乌萨奇|mochi|十六|16|qq|小窝|上炕|颜文字|oc|穿搭|画图/i
  },
  {
    key: "09", id: "416a76bfb8ff81f88880c0160068fc14",
    label: "当前交接（历史日期）",
    triggers: /最近怎么样|最近.*工作|最近.*加班|那天发生|上次说过|之前说过|我们上次|上回|前几天|请假|餐补|最新交接|回忆上次|接着上次|换窗口|昨天.*工作|上周.*工作/i
  }
]);

const MAX_EXTRA_PAGES = 2;

export function selectDetailPages(userText) {
  const input = String(userText || "").slice(-650);
  const matches = [];
  for (const page of DETAIL_PAGE_CATALOG) {
    const found = input.match(page.triggers);
    if (!found) continue;
    // Affectionate greetings alone are not requests to fetch relationship data.
    if (page.key === "03" && ["老公", "老婆"].includes(found[0])) {
      const hasSpecificRelation = /关系|结婚|伴侣|结扎|朋友|生日|孩子|吃醋|杨波|董姐|senior|lead|人设|身高/.test(input);
      if (!hasSpecificRelation) continue;
    }
    const matchLength = found[0].length;
    matches.push({ page, score: 100 + matchLength });
  }
  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, MAX_EXTRA_PAGES).map(match => match.page);
}

export function shouldLookUpRecentDiary(userText) {
  // A dated journal should be consulted only for timeline/recall questions.
  return /最近.*(日记|发生|怎么样)|今天.*(记录|日记)|昨天.*(做|干|说|发生)|上次.*(做|说|聊)|日记|这几天.*(做|发生)|前两天|上周.*(聊|发生)/i
    .test(String(userText || ""));
}
