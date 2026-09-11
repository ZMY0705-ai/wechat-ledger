/**
 * 支出分类体系（docs/02 §3），以及「把任何库对齐到这份体系」的幂等迁移。
 *
 * 为什么单独一个文件：分类清单有两个使用方——新库要在初始化时建出来，
 * 已经有一套旧分类的库要在打开时迁移过来。两处各抄一份清单，迟早会漂移。
 *
 * 粒度约定（很重要）：
 * · **一级分类由模型和规则解析器使用**。桥接只把一级分类塞进提示词
 *   （bridge/src/handler/router.js），所以模型选的就是这 7 个里的一个。
 * · **二级分类不参与自动判断**，只是网页下拉里的更细标注，以及 `?level=2` 的明细。
 *   饼图和日报按一级归并，扇区才不会碎成十几块。
 */

/** 支出：一级分类 -> 二级分类。这个顺序就是网页下拉与饼图的顺序 */
export const EXPENSE_TREE = {
  生活必需: ['日用品', '房租', '房贷', '水电燃气', '物业', '宽带', '话费', '书籍', '课程',
             '保险', '税费', '手续费', '利息'],
  食品餐饮: ['早饭', '午饭', '晚饭', '外卖', '零食饮料', '买菜', '请客'],
  购物消费: ['服饰', '数码', '网购'],
  健康医疗: ['门诊', '药品', '体检'],
  出行交通: ['打车', '公交地铁', '加油', '停车', '火车机票'],
  休闲娱乐: ['电影演出', '游戏', '旅行', '运动', '会员订阅'],
  人情送礼: ['红包', '礼物', '请客随礼'],
  待分类: [],
};

/** 收入：一级分类（无二级） */
export const INCOME_LIST = ['工资', '奖金', '兼职', '报销', '投资收益', '红包收入', '退款', '其他收入'];

/**
 * 迁移版本。改上面那份 EXPENSE_TREE 的影响面时**记得 +1**，
 * 否则老库不会重新对齐（见 db/index.js 的 migrate）。
 */
export const CATEGORY_VERSION = 2;

/**
 * 旧一级分类 → 新一级分类。
 * **原地改名**（id 不变）而不是「新建 + 迁流水」：历史流水指着 category_id，
 * 改名之后它们自动跟过来，一笔都不用动。
 */
const RENAMED_PARENTS = {
  餐饮: '食品餐饮',
  交通: '出行交通',
  购物: '购物消费',
  娱乐: '休闲娱乐',
  医疗: '健康医疗',
  人情: '人情送礼',
};

/**
 * 这 4 个旧一级分类在新体系里没有对应项。它们的二级分类已经搬到别处，
 * 自己留在这里只剩空壳，归档（不是删除——归档是隐藏，历史流水的外键还指着它）。
 */
const LEGACY_PARENTS = ['居住', '通讯', '学习', '金融'];

/**
 * 把库里的分类对齐到 EXPENSE_TREE / INCOME_LIST。可反复执行。
 *
 * 规则：
 * 1. 旧名先原地改名（餐饮 → 食品餐饮），保住 id
 * 2. 一级分类建齐、排好序
 * 3. 二级分类**按名字复用**——能搬的搬过来（日用品从「购物消费」搬到「生活必需」），
 *    搬不动才新建。这样库里不会留下一个同名却挂在别处的孤儿
 * 4. LEGACY_PARENTS 归档
 *
 * 只在这些值真的不一样时才写库：`openDatabase` 每次都会跑一遍，
 * 让只读命令（`ledger ls`）平白产生 WAL 写入是不划算的。
 */
export function reconcileCategories(db) {
  const log = { renamed: [], added: [], moved: [], archived: [], total: 0 };

  const topExpense = db.prepare(
    `SELECT id, name, sort_order FROM categories
      WHERE parent_id IS NULL AND direction = 'expense' AND archived = 0 AND name = ?`,
  );
  // 优先挑已经挂在目标父分类下面的那一个，其次才是别处的同名分类
  const childByName = db.prepare(
    `SELECT id, parent_id, sort_order FROM categories
      WHERE direction = 'expense' AND archived = 0 AND name = ?
      ORDER BY (parent_id = ?) DESC, id`,
  );
  const renameById = db.prepare('UPDATE categories SET name = ? WHERE id = ?');
  const moveTo = db.prepare('UPDATE categories SET parent_id = ?, sort_order = ? WHERE id = ?');
  const reorder = db.prepare('UPDATE categories SET sort_order = ? WHERE id = ?');
  const archiveById = db.prepare('UPDATE categories SET archived = 1 WHERE id = ?');
  const insertExpense = db.prepare(
    `INSERT INTO categories(name, parent_id, direction, sort_order) VALUES(?, ?, 'expense', ?)`,
  );
  const insertIncome = db.prepare(
    `INSERT INTO categories(name, parent_id, direction, sort_order) VALUES(?, NULL, 'income', ?)`,
  );

  // 1) 旧名原地改名。新名已经存在（比如手工建过）就跳过，交给第 4 步归档旧的那个
  for (const [oldName, newName] of Object.entries(RENAMED_PARENTS)) {
    const from = topExpense.get(oldName);
    if (from && !topExpense.get(newName)) {
      renameById.run(newName, from.id);
      log.renamed.push(`${oldName}→${newName}`);
    }
  }

  // 2) + 3) 一级建齐、二级复用或新建
  //
  // sort_order 用**全局递增**，不是「每个父分类从 0 开始」。列表查询的排序键是
  // `COALESCE(p.sort_order, c.sort_order), c.sort_order`（server/src/index.js），
  // 父子序号一旦相等，子分类会排到它父亲前面去。全局递增让「父 < 子」永远成立。
  let order = 0;
  for (const [parentName, children] of Object.entries(EXPENSE_TREE)) {
    const parentOrder = order++;
    let parent = topExpense.get(parentName);
    if (!parent) {
      parent = { id: Number(insertExpense.run(parentName, null, parentOrder).lastInsertRowid) };
      log.added.push(parentName);
    } else if (parent.sort_order !== parentOrder) {
      reorder.run(parentOrder, parent.id);
    }

    for (const childName of children ?? []) {
      const childOrder = order++;
      const existing = childByName.get(childName, parent.id);
      if (!existing) {
        insertExpense.run(childName, parent.id, childOrder);
        log.added.push(childName);
      } else if (existing.parent_id !== parent.id) {
        moveTo.run(parent.id, childOrder, existing.id);
        log.moved.push(childName);
      } else if (existing.sort_order !== childOrder) {
        reorder.run(childOrder, existing.id);
      }
    }
  }

  // 4) 空壳的旧一级分类归档（幂等：已经归档过的不会再出现在查询里）
  for (const name of LEGACY_PARENTS) {
    const row = topExpense.get(name);
    if (!row) continue;
    archiveById.run(row.id);
    log.archived.push(name);
  }

  // 收入分类保持原样，只保证建齐、排好序
  INCOME_LIST.forEach((name, order) => {
    const row = db.prepare(
      `SELECT id, sort_order FROM categories
        WHERE parent_id IS NULL AND direction = 'income' AND archived = 0 AND name = ?`,
    ).get(name);
    if (!row) insertIncome.run(name, order);
    else if (row.sort_order !== order) reorder.run(order, row.id);
  });

  log.total = db.prepare(
    `SELECT COUNT(*) AS n FROM categories WHERE archived = 0`,
  ).get().n;
  return log;
}