/**
 * 顶栏那只猫：瞳孔会跟着鼠标转。
 *
 * 纯装饰，成本很低——只动 SVG 里两个 pupil 的 transform，
 * 不引库、不加 DOM、不碰任何数据逻辑。停掉这个文件页面照样能跑。
 */
const mascot = document.getElementById('mascot');

if (mascot) {
  const pupils = [...mascot.querySelectorAll('.pupil')];
  const MAX_SHIFT = 1.7;   // 瞳孔最多偏离多少（viewBox 单位）

  const follow = (event) => {
    const box = mascot.getBoundingClientRect();
    const dx = event.clientX - (box.left + box.width / 2);
    const dy = event.clientY - (box.top + box.height / 2);
    const distance = Math.hypot(dx, dy) || 1;
    // 鼠标越远偏得越多，但有上限，免得瞳孔跑到眼眶外面
    const reach = Math.min(1, distance / 180) * MAX_SHIFT;
    const shiftX = (dx / distance) * reach;
    const shiftY = (dy / distance) * reach;
    for (const pupil of pupils) {
      pupil.style.transform = `translate(${shiftX.toFixed(2)}px, ${shiftY.toFixed(2)}px)`;
    }
  };

  window.addEventListener('mousemove', follow, { passive: true });
}