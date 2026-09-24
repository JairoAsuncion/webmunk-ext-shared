import { isCartUrl } from '../shared/StudyPolicy';
import { FINAL_SURVEY_URL } from '../shared/StudyConfig';
const el = (id:string) => document.getElementById(id)!;
const show = (id:string, yes:boolean) => { el(id).hidden = !yes; };
const preview = chrome.runtime.getManifest().name.includes('LOCAL PREVIEW');
const previewTools = preview && location.pathname.endsWith('/preview-tools.html');
let selected = '';
let itemsKey = '';
let busy = false;
let actionError = '';
let state: Record<string, any> = {};
function updateConfirm() {
  (el('confirm') as HTMLButtonElement).disabled = busy || !selected || !(el('confirmed') as HTMLInputElement).checked || !state.amazonLoginConfirmed;
}
async function action(type:string, extra:Record<string, any> = {}) {
  if (busy) return;
  busy = true; actionError = ''; updateConfirm(); show('error',false);
  document.querySelectorAll<HTMLButtonElement>('button').forEach(b => { b.disabled = true; });
  try {
    const result = await chrome.runtime.sendMessage({type,...extra});
    if (!result?.ok) throw new Error(result?.error || 'The extension did not respond. Reload Amazon and try again.');
  } catch (e) {
    actionError = e instanceof Error ? e.message : String(e);
    el('error').textContent = actionError; show('error',true);
  } finally {
    busy = false;
    document.querySelectorAll<HTMLButtonElement>('button').forEach(b => { b.disabled = false; });
    await render(); updateConfirm();
  }
}
async function render() {
  state = await chrome.storage.local.get(null);
  const stage = state.taskStage || 'initial', c = state.studyContext;
  const completed = stage === 'final' && !!state.surveyOpenedAt;
  show('completedOnly', completed && !previewTools);
  show('studyUi', !completed || previewTools);
  if (completed && !previewTools) return;
  show('preview', preview); show('testTools',preview);
  const p2Url = state.previewP2Url ?? FINAL_SURVEY_URL;
  if (document.activeElement !== el('p2Url')) (el('p2Url') as HTMLInputElement).value = p2Url;
  el('p2Status').textContent = p2Url ? 'P2 is connected. Confirmation will open Qualtrics with a test marker.' : 'P2 disabled; completion stays local.';
  show('waiting', stage === 'initial' || stage === 'registering');
  (el('retry') as HTMLButtonElement).disabled = busy || stage === 'registering';
  show('task',stage === 'shopping'); show('finished',stage === 'final');
  show('stopped',stage === 'stopped' || stage === 'done');
  el('status').textContent = stage === 'registering' ? 'Registering your study session…' :
    stage === 'shopping' ? 'Shopping task in progress' : stage === 'final' ? 'Final product confirmed' :
    stage === 'stopped' || stage === 'done' ? 'Shopping task stopped' : 'Waiting for the study’s Amazon link';
  el('error').textContent = state.studyError || actionError;
  show('error',!!(state.studyError || actionError));
  el('studyNotice').textContent = state.studyNotice || '';
  show('studyNotice', stage === 'shopping' && !!state.studyNotice);
  if (state.dataUploadError) el('upload').textContent = state.dataUploadError;
  show('upload',!!state.dataUploadError);
  if (c) {
    el('assignment').textContent = 'Your task: ' + c.category + ' · Budget: $' + c.budget;
    el('pid').textContent = 'Participant ID: ' + c.prolificId;
    show('guided', c.arm === 'chat');
  }
  show('login', stage === 'shopping' && !state.amazonLoginConfirmed);
  const cart = state.currentCart;
  show('cartReview', !!cart && isCartUrl(cart.url));
  const items = cart?.items || [];
  const key = JSON.stringify(items);
  if (key !== itemsKey) {
    itemsKey = key; selected = ''; (el('confirmed') as HTMLInputElement).checked = false;
    el('items').replaceChildren();
    items.forEach((item:any) => {
      const label = document.createElement('label'); label.className = 'product';
      const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'product'; radio.value = item.asin;
      radio.addEventListener('change', () => { selected = item.asin; (el('confirmed') as HTMLInputElement).checked = false; updateConfirm(); });
      const text = document.createElement('span');
      text.textContent = item.title + ' — ' + (item.price || 'Price not detected; check the Amazon page') + ' (' + item.asin + ')';
      label.append(radio,text); el('items').append(label);
    });
  }
  show('cartHelp',items.length === 0);
  el('cartHelp').textContent = cart && isCartUrl(cart.url) ?
    'No readable active-cart products were found. Add your choice, reload Amazon, then refresh this list. Do not continue if the wrong product is shown.' :
    'Open your Amazon cart to see the products available for confirmation.';
  if (state.finalChoice) el('choice').textContent = 'Chosen product: ' + state.finalChoice.title;
  show('previewDone',preview && stage === 'final');
  (el('continue') as HTMLButtonElement).textContent = preview && !p2Url ? 'Verify preview completion' : 'Continue to follow-up survey';
  if (previewTools) {
    for (const id of ['waiting','task','finished','stopped','status']) show(id, false);
  }
  updateConfirm();
}
el('retry').addEventListener('click',() => void action('study_retry'));
el('saveP2').addEventListener('click',() => void action('study_preview_p2', {url:(el('p2Url') as HTMLInputElement).value.trim()}));
el('cart').addEventListener('click',() => void action('study_cart'));
el('refresh').addEventListener('click',() => void action('study_refresh_cart'));
el('confirm').addEventListener('click',() => void action('study_confirm', {asin:selected, confirmed:(el('confirmed') as HTMLInputElement).checked}));
el('confirmed').addEventListener('change',updateConfirm);
el('continue').addEventListener('click',() => void action('study_continue'));
el('stop').addEventListener('click',() => {
  if (window.confirm('Stop the shopping task and stop collecting shopping activity? This cannot be undone for this session.')) void action('study_stop');
});
el('reset').addEventListener('click',() => {
  if (window.confirm('Clear this preview session and its local test events? Download events first if you want to keep them.')) void action('study_preview_reset');
});
el('export').addEventListener('click',async () => {
  const s = await chrome.storage.local.get(['previewEvents','studyContext','finalChoice','studySummary','taskStage']);
  const url = URL.createObjectURL(new Blob([JSON.stringify(s,null,2)],{type:'application/json'}));
  const a = document.createElement('a'); a.href = url; a.download = 'webmunk-local-test.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url),1000);
});
chrome.storage.onChanged.addListener((_changes,area) => { if (area === 'local') void render(); });
void render();
