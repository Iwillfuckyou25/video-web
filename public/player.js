(function () {
  const timeText = seconds => {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
  };

  window.setupPlayer = function setupProfessionalPlayer(videoData) {
    const video = document.querySelector('#videoPlayer');
    const shell = document.querySelector('#playerShell');
    if (!video || !shell) return;

    video.controls = false;
    video.preload = 'auto';
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    shell.querySelector('.player-spinner')?.setAttribute('aria-hidden', 'true');
    shell.insertAdjacentHTML('beforeend', `
      <button class="center-play show" data-control="play" aria-label="Play video">&#9654;</button>
      <div class="pro-controls">
        <input class="pro-seek" data-control="seek" type="range" min="0" max="1000" value="0" aria-label="Seek video">
        <div class="pro-control-row">
          <button data-control="play" aria-label="Play">&#9654;</button>
          <button data-control="mute" aria-label="Mute">&#128266;</button>
          <input class="pro-volume" data-control="volume" type="range" min="0" max="1" step="0.05" value="1" aria-label="Volume">
          <span class="pro-time">0:00 / 0:00</span>
          <span class="pro-spacer"></span>
          <select data-control="quality" aria-label="Video quality"><option>Original</option></select>
          <select data-control="speed" aria-label="Playback speed">
            <option value="0.25">0.25x</option><option value="0.5">0.5x</option><option value="0.75">0.75x</option>
            <option value="1" selected>1x</option><option value="1.25">1.25x</option><option value="1.5">1.5x</option><option value="2">2x</option>
          </select>
          <button data-control="pip" aria-label="Picture in picture">PiP</button>
          <button data-control="fullscreen" aria-label="Fullscreen">&#x26F6;</button>
        </div>
      </div>`);

    document.querySelector('#speed')?.remove();
    const playButtons = shell.querySelectorAll('[data-control="play"]');
    const centerPlay = shell.querySelector('.center-play');
    const seek = shell.querySelector('[data-control="seek"]');
    const volume = shell.querySelector('[data-control="volume"]');
    const mute = shell.querySelector('[data-control="mute"]');
    const clock = shell.querySelector('.pro-time');
    const gesture = shell.querySelector('.gesture');
    const bubble = gesture?.querySelector('span');
    let bufferTimer;
    let controlsTimer;
    let lastTap = 0;
    let seeking = false;

    const togglePlay = () => video.paused ? video.play() : video.pause();
    const syncPlay = () => {
      playButtons.forEach(button => { button.innerHTML = video.paused ? '&#9654;' : '&#10074;&#10074;'; });
      centerPlay.classList.toggle('show', video.paused);
    };
    const showControls = () => {
      shell.classList.add('controls-visible');
      clearTimeout(controlsTimer);
      if (!video.paused) controlsTimer = setTimeout(() => shell.classList.remove('controls-visible'), 2800);
    };
    const setBuffering = active => {
      clearTimeout(bufferTimer);
      if (active) bufferTimer = setTimeout(() => shell.classList.add('buffering'), 500);
      else shell.classList.remove('buffering');
    };
    const flash = text => {
      if (!gesture || !bubble) return;
      bubble.textContent = text;
      gesture.classList.add('show');
      setTimeout(() => gesture.classList.remove('show'), 450);
    };

    playButtons.forEach(button => button.addEventListener('click', event => { event.stopPropagation(); togglePlay(); }));
    video.addEventListener('click', togglePlay);
    video.addEventListener('play', syncPlay);
    video.addEventListener('pause', () => { syncPlay(); showControls(); });
    video.addEventListener('waiting', () => setBuffering(true));
    video.addEventListener('stalled', () => setBuffering(true));
    video.addEventListener('playing', () => { setBuffering(false); syncPlay(); showControls(); });
    video.addEventListener('canplay', () => setBuffering(false));
    video.addEventListener('loadedmetadata', () => {
      clock.textContent = `0:00 / ${timeText(video.duration)}`;
      const saved = Number(localStorage.getItem(`resume:${videoData._id}`));
      if (saved > 5 && saved < video.duration - 10) video.currentTime = saved;
    });
    video.addEventListener('timeupdate', () => {
      if (!seeking && video.duration) seek.value = Math.round(video.currentTime / video.duration * 1000);
      clock.textContent = `${timeText(video.currentTime)} / ${timeText(video.duration)}`;
      localStorage.setItem(`resume:${videoData._id}`, video.currentTime);
    });
    seek.addEventListener('input', () => { seeking = true; if (video.duration) clock.textContent = `${timeText(seek.value / 1000 * video.duration)} / ${timeText(video.duration)}`; });
    seek.addEventListener('change', () => { if (video.duration) video.currentTime = seek.value / 1000 * video.duration; seeking = false; });
    volume.addEventListener('input', () => { video.volume = Number(volume.value); video.muted = false; mute.textContent = video.volume ? '🔊' : '🔇'; });
    mute.addEventListener('click', event => { event.stopPropagation(); video.muted = !video.muted; mute.textContent = video.muted ? '🔇' : '🔊'; });
    shell.querySelector('[data-control="speed"]').addEventListener('change', event => { video.playbackRate = Number(event.target.value); });
    shell.querySelector('[data-control="pip"]').addEventListener('click', async event => {
      event.stopPropagation();
      if (!document.pictureInPictureEnabled) return window.showToast?.('PiP is not supported on this device');
      try { document.pictureInPictureElement ? await document.exitPictureInPicture() : await video.requestPictureInPicture(); } catch (_) {}
    });
    shell.querySelector('[data-control="fullscreen"]').addEventListener('click', event => {
      event.stopPropagation();
      if (document.fullscreenElement) document.exitFullscreen();
      else if (shell.requestFullscreen) shell.requestFullscreen();
      else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
    });
    shell.addEventListener('pointermove', showControls);
    shell.addEventListener('pointerleave', () => { if (!video.paused) shell.classList.remove('controls-visible'); });
    shell.addEventListener('pointerup', event => {
      if (event.target.closest('.pro-controls,.center-play')) return;
      const now = Date.now();
      if (now - lastTap < 320) {
        const delta = event.clientX < shell.getBoundingClientRect().left + shell.clientWidth / 2 ? -10 : 10;
        video.currentTime = Math.max(0, Math.min(video.duration || Infinity, video.currentTime + delta));
        flash(delta < 0 ? '-10' : '+10');
      }
      lastTap = now;
    });
    document.onkeydown = event => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
      const key = event.key.toLowerCase();
      const actions = {
        ' ': togglePlay, k: togglePlay, j: () => video.currentTime -= 10, l: () => video.currentTime += 10,
        arrowleft: () => video.currentTime -= 5, arrowright: () => video.currentTime += 5,
        m: () => video.muted = !video.muted,
        f: () => document.fullscreenElement ? document.exitFullscreen() : shell.requestFullscreen(),
        arrowup: () => video.volume = Math.min(1, video.volume + 0.05),
        arrowdown: () => video.volume = Math.max(0, video.volume - 0.05)
      };
      if (actions[key]) { event.preventDefault(); actions[key](); showControls(); }
    };
    syncPlay();
    showControls();
    video.load();
  };

  async function makeThumbnail(file) {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';
    video.src = url;
    try {
      await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = reject; });
      video.currentTime = Math.min(Math.max(0.5, video.duration * 0.1), Math.max(0.5, video.duration - 0.1));
      await new Promise((resolve, reject) => { video.onseeked = resolve; video.onerror = reject; });
      const canvas = document.createElement('canvas');
      canvas.width = 960;
      canvas.height = 540;
      const context = canvas.getContext('2d');
      const scale = Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
      const width = video.videoWidth * scale;
      const height = video.videoHeight * scale;
      context.drawImage(video, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
      return await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.84));
    } finally { URL.revokeObjectURL(url); }
  }

  document.addEventListener('submit', async event => {
    if (event.target.id !== 'uploadForm') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const form = event.target;
    const button = form.querySelector('button');
    const bar = form.querySelector('.progress span');
    const videoFile = form.querySelector('[name="video"]').files[0];
    const thumbInput = form.querySelector('[name="thumbnail"]');
    button.disabled = true;
    button.textContent = thumbInput.files[0] ? 'Preparing upload…' : 'Creating thumbnail…';
    const data = new FormData(form);
    try {
      if (!thumbInput.files[0]) {
        const thumbnail = await makeThumbnail(videoFile);
        if (thumbnail) data.set('thumbnail', thumbnail, 'auto-thumbnail.jpg');
      }
      button.textContent = 'Uploading…';
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      xhr.setRequestHeader('x-admin-password', sessionStorage.getItem('adminPassword') || '');
      xhr.upload.onprogress = progress => { if (progress.lengthComputable) bar.style.width = `${progress.loaded / progress.total * 100}%`; };
      xhr.onload = () => {
        button.disabled = false;
        if (xhr.status === 201) { window.showToast?.('Video uploaded successfully'); history.pushState({}, '', '/admin'); window.dispatchEvent(new PopStateEvent('popstate')); }
        else { button.textContent = 'Upload video'; try { window.showToast?.(JSON.parse(xhr.responseText).error || 'Upload failed'); } catch (_) {} }
      };
      xhr.onerror = () => { button.disabled = false; button.textContent = 'Upload video'; window.showToast?.('Network error'); };
      xhr.send(data);
    } catch (_) {
      button.disabled = false;
      button.textContent = 'Upload video';
      window.showToast?.('Could not create thumbnail. Please select one manually.');
    }
  }, true);
})();
