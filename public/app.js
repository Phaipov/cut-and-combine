const $ = selector => document.querySelector(selector);
const toast = $('#toast');
let cutVideo;
let combineVideos = [];
let combineSourcePaths = [];
let draggedClipIndex = null;
let cutVideoDuration = 0;
let outputFolder;
let sourceVideoPath = '';
let language = localStorage.getItem('clip-candy-language') || 'en';

const translations = {
  en: {
    cutTab: 'Cut a clip', combineTab: 'Combine clips', cutTitle: 'Cut your video', cutSubtitle: 'Keep just the good bit.',
    dropVideo: 'Drop your video here', browseFiles: 'or browse files · MP4, MOV, WebM', partCount: 'Number of video parts',
    splitHelp: 'We’ll split your video into equal-length parts.', cutButton: 'Cut my clips', combineTitle: 'Combine your videos',
    combineSubtitle: 'Put your moments in order.', addVideos: 'Add two or more videos', combineHelp: 'Choose files in the order you want them played',
    combineButton: 'Combine my clips', saveLocation: 'Save location', defaultFolder: 'Downloads folder (default)', openFolder: 'Open folder', chooseFolder: 'Choose folder', cancel: 'Cancel',
    fadeTransition: 'Fade transition', seconds: 'seconds', fadeHint: '0 = no fade (fastest)'
  },
  kh: {
    cutTab: 'កាត់វីដេអូ', combineTab: 'ភ្ជាប់វីដេអូ', cutTitle: 'កាត់វីដេអូរបស់អ្នក', cutSubtitle: 'កាត់ជាផ្នែកៗតាមចំនួនដែលចង់បាន។',
    dropVideo: 'ដាក់វីដេអូនៅទីនេះ', browseFiles: 'ឬជ្រើសរើសឯកសារ · MP4, MOV, WebM', partCount: 'ចំនួនផ្នែកវីដេអូ',
    splitHelp: 'យើងនឹងចែកវីដេអូជាផ្នែកមានរយៈពេលស្មើគ្នា។', cutButton: 'កាត់វីដេអូ', combineTitle: 'ភ្ជាប់វីដេអូរបស់អ្នក',
    combineSubtitle: 'រៀបលំដាប់វីដេអូតាមដែលអ្នកចង់បាន។', addVideos: 'បន្ថែមវីដេអូពីរ ឬច្រើនជាងនេះ', combineHelp: 'អូសដើម្បីរៀបលំដាប់វីដេអូ',
    combineButton: 'ភ្ជាប់វីដេអូ', saveLocation: 'ទីតាំងរក្សាទុក', defaultFolder: 'ថត Downloads (លំនាំដើម)', openFolder: 'បើកថត', chooseFolder: 'ជ្រើសថត', cancel: 'បោះបង់',
    fadeTransition: 'ចន្លោះវីដេអូ (Fade)', seconds: 'វិនាទី', fadeHint: '0 = គ្មាន Fade (លឿនបំផុត)'
  }
};

function setLanguage(nextLanguage) {
  language = nextLanguage;
  localStorage.setItem('clip-candy-language', language);
  document.documentElement.lang = language === 'kh' ? 'km' : 'en';
  document.body.classList.toggle('khmer', language === 'kh');
  document.querySelectorAll('[data-i18n]').forEach(element => { element.textContent = translations[language][element.dataset.i18n]; });
  document.querySelectorAll('[data-language]').forEach(button => button.classList.toggle('active', button.dataset.language === language));
}

function say(message, error = false) {
  toast.textContent = message;
  toast.className = `toast show${error ? ' error' : ''}`;
  setTimeout(() => toast.className = 'toast', 4500);
}

document.querySelectorAll('[data-language]').forEach(button => button.addEventListener('click', () => setLanguage(button.dataset.language)));
setLanguage(language);

let progressTimer;
let activeRequest;
let activeJobId = '';
function showProgress() {
  let progress = 4;
  $('#process-box').hidden = false;
  const update = () => {
    $('#progress-bar').style.width = `${progress}%`;
    $('#process-percent').textContent = `${Math.round(progress)}%`;
    $('#process-label').textContent = progress > 82 ? 'Preparing your files…' : progress > 18 ? 'Cutting video parts…' : 'Uploading video…';
  };
  update();
  progressTimer = setInterval(async () => {
    try {
      const response = await fetch(`/api/progress/${activeJobId}`);
      const status = await response.json();
      if (status.active && status.percent > 0) progress = Math.max(progress, status.percent);
      else progress = Math.min(20, progress + .5);
      update();
    } catch (_) {}
  }, 700);
}

function finishProgress(success) {
  clearInterval(progressTimer);
  $('#progress-bar').style.width = success ? '100%' : '0%';
  $('#process-percent').textContent = success ? '100%' : '0%';
  $('#process-label').textContent = success ? 'Cut completed!' : 'Could not complete the cut';
  $('#process-note').textContent = success ? 'Your video files are ready.' : 'Please try again.';
  setTimeout(() => { $('#process-box').hidden = true; }, success ? 3500 : 5000);
}

$('#cancel-process').addEventListener('click', async () => {
  if (!activeRequest || !activeJobId) return;
  $('#cancel-process').disabled = true;
  $('#process-label').textContent = 'Cancelling process…';
  $('#process-note').textContent = 'Stopping video processing.';
  activeRequest.abort();
  await fetch('/api/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: activeJobId }) }).catch(() => {});
  activeRequest = null;
  activeJobId = '';
  finishProgress(false);
  say('Process cancelled.');
});

document.querySelectorAll('[data-tool]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('[data-tool]').forEach(item => item.classList.toggle('active', item === button));
  document.querySelectorAll('.tool-panel').forEach(panel => panel.classList.toggle('active', panel.id === `${button.dataset.tool}-panel`));
}));

function showCutFile(file) {
  if (!file) return;
  cutVideo = file;
  if (window.desktopAPI) sourceVideoPath = window.desktopAPI.sourcePath(file);
  $('#cut-selected').hidden = false;
  $('#cut-selected').innerHTML = `<div class="file-pill"><b>🎬 ${file.name}</b><span>${(file.size / 1048576).toFixed(1)} MB</span></div>`;
  const preview = $('#cut-preview');
  preview.src = URL.createObjectURL(file);
  $('#trim-controls').hidden = false;
  $('#cut-submit').disabled = false;
  preview.onloadedmetadata = () => {
    cutVideoDuration = preview.duration;
    updatePartDuration();
  };
}
$('#cut-file').addEventListener('change', event => showCutFile(event.target.files[0]));

function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return minutes ? `${minutes} min ${remainingSeconds} sec` : `${remainingSeconds} sec`;
}

function updatePartDuration() {
  const parts = Math.max(1, Number.parseInt($('#cut-count').value, 10) || 1);
  $('#duration-note').textContent = cutVideoDuration ? `Each video: ${formatDuration(cutVideoDuration / parts)}` : '';
}

$('#cut-count').addEventListener('input', updatePartDuration);

$('#choose-folder').addEventListener('click', async () => {
  if (!window.showDirectoryPicker) return say('Your browser does not support folder selection. Use Chrome or Edge.', true);
  try {
    outputFolder = await window.showDirectoryPicker({ mode: 'readwrite' });
    $('#save-folder-name').textContent = outputFolder.name;
    say(`Files will save to ${outputFolder.name}`);
  } catch (error) {
    if (error.name !== 'AbortError') say('Could not use that folder.', true);
  }
});

$('#open-folder').addEventListener('click', async () => {
  if (!window.desktopAPI) return say('Open folder is available in the Desktop app.', true);
  if (!sourceVideoPath) return say('Please choose a video first.', true);
  const error = await window.desktopAPI.openSourceFolder(sourceVideoPath);
  if (error) say('Could not open the folder.', true);
});

function showCombineFiles(files) {
  combineVideos = [...combineVideos, ...files];
  if (window.desktopAPI) combineSourcePaths = [...combineSourcePaths, ...[...files].map(file => window.desktopAPI.sourcePath(file))];
  renderCombineFiles();
}

function renderCombineFiles() {
  // The combined video is saved beside the first clip in the current order.
  if (window.desktopAPI && combineSourcePaths.length) sourceVideoPath = combineSourcePaths[0];
  $('#clip-list').innerHTML = combineVideos.map((file, index) => `<li draggable="true" data-index="${index}"><span class="drag-handle" title="Drag to reorder">⠿</span><b>${file.name}</b><button class="remove" data-remove="${index}" title="Remove">×</button></li>`).join('');
  $('#combine-submit').disabled = combineVideos.length < 2;
}
$('#combine-files').addEventListener('change', event => showCombineFiles(event.target.files));
$('#clip-list').addEventListener('click', event => {
  const index = event.target.dataset.remove;
  if (index === undefined) return;
  combineVideos.splice(index, 1);
  combineSourcePaths.splice(index, 1);
  renderCombineFiles();
});

$('#clip-list').addEventListener('dragstart', event => {
  const item = event.target.closest('li');
  if (!item) return;
  draggedClipIndex = Number(item.dataset.index);
  item.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
});
$('#clip-list').addEventListener('dragover', event => {
  event.preventDefault();
  event.target.closest('li')?.classList.add('drag-over');
});
$('#clip-list').addEventListener('dragleave', event => event.target.closest('li')?.classList.remove('drag-over'));
$('#clip-list').addEventListener('dragend', () => document.querySelectorAll('#clip-list li').forEach(item => item.classList.remove('dragging', 'drag-over')));
$('#clip-list').addEventListener('drop', event => {
  event.preventDefault();
  const item = event.target.closest('li');
  const targetIndex = item ? Number(item.dataset.index) : draggedClipIndex;
  if (draggedClipIndex === null || targetIndex === draggedClipIndex) return;
  const [video] = combineVideos.splice(draggedClipIndex, 1);
  combineVideos.splice(targetIndex, 0, video);
  if (combineSourcePaths.length) {
    const [sourcePath] = combineSourcePaths.splice(draggedClipIndex, 1);
    combineSourcePaths.splice(targetIndex, 0, sourcePath);
  }
  draggedClipIndex = null;
  renderCombineFiles();
});

for (const [dropId, inputId, handler] of [['cut-drop', 'cut-file', files => showCutFile(files[0])], ['combine-drop', 'combine-files', showCombineFiles]]) {
  const drop = $(`#${dropId}`);
  ['dragenter', 'dragover'].forEach(event => drop.addEventListener(event, e => { e.preventDefault(); drop.classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach(event => drop.addEventListener(event, e => { e.preventDefault(); drop.classList.remove('dragging'); }));
  drop.addEventListener('drop', event => handler(event.dataTransfer.files));
}

async function render(url, form, button) {
  button.disabled = true;
  const original = button.innerHTML;
  let completed = false;
  activeJobId = crypto.randomUUID();
  activeRequest = new AbortController();
  form.append('jobId', activeJobId);
  $('#cancel-process').disabled = false;
  showProgress();
  button.innerHTML = 'Making magic… <span>✦</span>';
  try {
    const response = await fetch(url, { method: 'POST', body: form, signal: activeRequest.signal });
    if (!response.ok) throw new Error((await response.json()).error || 'Something went wrong.');
    if (url.includes('/cut') || url.includes('/combine-local')) {
      const { files, localSaved } = await response.json();
      if (localSaved) {
        // Desktop fast path already wrote the parts beside the original video.
      } else for (const file of files) {
        const videoResponse = await fetch(file.url);
        const blob = await videoResponse.blob();
        if (outputFolder) {
          const handle = await outputFolder.getFileHandle(file.name, { create: true });
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
        } else {
          const link = document.createElement('a');
          link.href = URL.createObjectURL(blob);
          link.download = file.name;
          link.click();
          URL.revokeObjectURL(link.href);
        }
      }
      say(localSaved ? `${url.includes('combine') ? 'បានភ្ជាប់វីដេអូជោគជ័យហើយ!' : 'កាត់បានជោគជ័យហើយ!'} បានរក្សាទុកនៅ folder ដើម` : outputFolder ? `កាត់បានជោគជ័យហើយ! បានរក្សាទុក ${files.length} វីដេអូទៅ ${outputFolder.name}` : 'កាត់បានជោគជ័យហើយ! កំពុងទាញយកវីដេអូ');
    } else {
      const blob = await response.blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'combined-video.mp4';
      link.click();
      URL.revokeObjectURL(link.href);
      say('Your video is ready — enjoy!');
    }
    completed = true;
  } catch (error) { if (error.name !== 'AbortError') say(error.message, true); }
  finally { if (activeRequest) finishProgress(completed); activeRequest = null; activeJobId = ''; button.disabled = false; button.innerHTML = original; }
}

$('#cut-submit').addEventListener('click', () => {
  const data = new FormData(); data.append('parts', $('#cut-count').value);
  if (window.desktopAPI && sourceVideoPath) {
    data.append('sourcePath', sourceVideoPath);
    render('/api/cut-local', data, $('#cut-submit'));
  } else {
    data.append('video', cutVideo);
    render('/api/cut', data, $('#cut-submit'));
  }
});
$('#combine-submit').addEventListener('click', () => { const data = new FormData(); data.append('fadeDuration', $('#fade-duration').value); if (window.desktopAPI && combineSourcePaths.length === combineVideos.length) { data.append('sourcePaths', JSON.stringify(combineSourcePaths)); render('/api/combine-local', data, $('#combine-submit')); } else { combineVideos.forEach(file => data.append('videos', file)); render('/api/combine', data, $('#combine-submit')); } });
