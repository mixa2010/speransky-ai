/* Model state ranks and locale-aware labels for the model chooser. */
'use strict';
const STATE_RANK = { ok: 0, new: 1, unstable: 2, cooldown: 3, dead: 4 };

function modelStateLabel(state) {
  const key = 'model.status.' + state;
  return (I18N[getLanguage()] && I18N[getLanguage()][key]) || I18N.en[key] || t('model.unknownStatus');
}
function modelStateTitle(state) {
  const key = 'model.statusTip.' + state;
  return (I18N[getLanguage()] && I18N[getLanguage()][key]) || t('model.unknownStatus');
}
