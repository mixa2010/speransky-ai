/* Бренд-знак «Сперанский AI»: буква «С» + искра ИИ в её раскрытии.
   Единый источник разметки знака. В index.html ровно этот же SVG лежит
   инлайном в стартовом экране — знак должен быть виден до загрузки
   скриптов и без сети. Совпадение двух копий проверяет тест.
   Загружается до app.js и делит с ним глобальную область (обычный скрипт). */
'use strict';

const LOGO_GLYPH =
  '<path class="lg-c" d="M14.2 7.5A5.3 5.3 0 1 0 14.2 16.5" fill="none" ' +
  'stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>' +
  '<path class="lg-spark" d="M17.6 9.25Q18.1 11.5 20.35 12Q18.1 12.5 17.6 14.75' +
  'Q17.1 12.5 14.85 12Q17.1 11.5 17.6 9.25Z" fill="currentColor"/>';
const LOGO_SVG = '<svg class="logo-glyph" viewBox="0 0 24 24" aria-hidden="true" ' +
  'focusable="false">' + LOGO_GLYPH + '</svg>';

/* Полный знак-плашка: <span class="logo"> + глиф внутри. Размер задаёт CSS. */
function logoMark(extraClass) {
  return '<span class="logo' + (extraClass ? ' ' + extraClass : '') +
    '" aria-hidden="true">' + LOGO_SVG + '</span>';
}

/* Заполняет пустые заготовки <span class="logo" data-logo></span>.
   Уже отрисованный инлайн-знак (стартовый экран) не трогаем, чтобы
   не перезапускать анимацию рисования буквы. */
function paintLogos(root) {
  const scope = root || document;
  scope.querySelectorAll('.logo[data-logo]').forEach((el) => {
    if (!el.firstChild) el.innerHTML = LOGO_SVG;
  });
}
