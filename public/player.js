(function () {
  const timeText = seconds => {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
  };

  window.setupPlayer = function setupProfessionalPlayer(videoData) {
    const video = document.querySelector('#videoPlayer');
    const shell = document.querySelector('#playerShell');
    if (!video || !shell) return;
    let sources = videoData.sources?.length ? videoData.sources : [{ label: 'Original', url: videoData.videoUrl }];
    clearInterval(window.playerProcessingTimer);

    video.controls = false;
    video.preload = 'auto';
    video.src = sources[0].url;
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
          <div class="quality-control">
            <button data-control="quality-menu" type="button" aria-label="Video quality" aria-expanded="false">&#9881; <span data-quality-label>${sources[0].label}</span></button>
            <div class="quality-menu" role="menu">${sources.map((source, index) => `<button type="button" role="menuitemradio" aria-checked="${index === 0}" data-quality-index="${index}">${source.label}</button>`).join('')}</div>
          </div>
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
    const barPlayButton = shell.querySelector('.pro-controls [data-control="play"]');
    const centerPlay = shell.querySelector('.center-play');
    const seek = shell.querySelector('[data-control="seek"]');
    const volume = shell.querySelector('[data-control="volume"]');
    const mute = shell.querySelector('[data-control="mute"]');
    const clock = shell.querySelector('.pro-time');
    const gesture = shell.querySelector('.gesture');
    const bubble = gesture?.querySelector('span');
    let controlsTimer;
    let lastTap = 0;
    let seeking = false;
    let hasEnded = false;
    let playbackId = '';
    let watchedSeconds = 0;
    let lastPlaybackTime = 0;
    let viewSubmitted = false;

    const ensurePlayback = () => {
      if (!playbackId) playbackId = crypto.randomUUID();
      lastPlaybackTime = video.currentTime;
    };
    const submitQualifiedView = () => {
      if (viewSubmitted) return;
      const duration = Number(video.duration || videoData.duration || 0);
      const requiredSeconds = Math.min(10, Math.max(3, duration * 0.25));
      if (watchedSeconds < requiredSeconds) return;
      viewSubmitted = true;
      let visitorId = localStorage.getItem('s3xVisitorId');
      if (!visitorId) { visitorId = crypto.randomUUID(); localStorage.setItem('s3xVisitorId', visitorId); }
      fetch(`/api/videos/${videoData._id}/view`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visitorId, playbackId, watchedSeconds }) }).catch(() => {});
      window.gtag?.('event', 'video_view', { video_title: videoData.title, video_id: videoData._id });
    };

    const togglePlay = () => {
      if (hasEnded || video.ended) { video.currentTime = 0; hasEnded = false; return video.play(); }
      return video.paused ? video.play() : video.pause();
    };
    const syncPlay = () => {
      if (barPlayButton) {
        barPlayButton.innerHTML = video.paused ? '&#9654;' : '&#10074;&#10074;';
        barPlayButton.setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
      }
      centerPlay.innerHTML = hasEnded ? '&#8635; <span>Replay</span>' : '&#9654;';
      centerPlay.setAttribute('aria-label', hasEnded ? 'Replay video' : 'Play video');
      centerPlay.classList.toggle('replay', hasEnded);
      centerPlay.classList.toggle('show', video.paused);
    };
    const showControls = () => {
      shell.classList.add('controls-visible');
      clearTimeout(controlsTimer);
      if (!video.paused) controlsTimer = setTimeout(() => shell.classList.remove('controls-visible'), 2800);
    };
    const flash = text => {
      if (!gesture || !bubble) return;
      bubble.textContent = text;
      gesture.classList.add('show');
      setTimeout(() => gesture.classList.remove('show'), 450);
    };

    playButtons.forEach(button => button.addEventListener('click', event => { event.stopPropagation(); togglePlay(); }));
    video.addEventListener('click', showControls);
    video.addEventListener('play', () => {
      hasEnded = false;
      ensurePlayback();
      syncPlay();
      window.gtag?.('event', 'video_start', { video_title: videoData.title, video_id: videoData._id });
    });
    video.addEventListener('pause', () => { syncPlay(); showControls(); });
    video.addEventListener('ended', () => { submitQualifiedView(); playbackId = ''; watchedSeconds = 0; lastPlaybackTime = 0; viewSubmitted = false; hasEnded = true; syncPlay(); showControls(); });
    video.addEventListener('waiting', () => shell.classList.remove('buffering'));
    video.addEventListener('stalled', () => shell.classList.remove('buffering'));
    video.addEventListener('playing', () => { shell.classList.remove('buffering'); syncPlay(); showControls(); });
    video.addEventListener('canplay', () => shell.classList.remove('buffering'));
    const syncDuration = () => { clock.textContent = `${timeText(video.currentTime)} / ${timeText(video.duration || videoData.duration)}`; };
    video.addEventListener('loadedmetadata', () => {
      syncDuration();
      const saved = Number(localStorage.getItem(`resume:${videoData._id}`));
      if (saved > 5 && saved < video.duration - 10) video.currentTime = saved;
    });
    video.addEventListener('durationchange', syncDuration);
    video.addEventListener('timeupdate', () => {
      if (!video.paused && !seeking && playbackId) {
        const delta = video.currentTime - lastPlaybackTime;
        if (delta > 0 && delta <= 2) watchedSeconds += delta;
        lastPlaybackTime = video.currentTime;
        submitQualifiedView();
      }
      if (!seeking && video.duration) seek.value = Math.round(video.currentTime / video.duration * 1000);
      clock.textContent = `${timeText(video.currentTime)} / ${timeText(video.duration)}`;
      localStorage.setItem(`resume:${videoData._id}`, video.currentTime);
    });
    video.addEventListener('seeking', () => { lastPlaybackTime = video.currentTime; });
    seek.addEventListener('input', () => { seeking = true; if (video.duration) clock.textContent = `${timeText(seek.value / 1000 * video.duration)} / ${timeText(video.duration)}`; });
    seek.addEventListener('change', () => { if (video.duration) video.currentTime = seek.value / 1000 * video.duration; seeking = false; });
    volume.addEventListener('input', () => { video.volume = Number(volume.value); video.muted = false; mute.textContent = video.volume ? '🔊' : '🔇'; });
    mute.addEventListener('click', event => { event.stopPropagation(); video.muted = !video.muted; mute.textContent = video.muted ? '🔇' : '🔊'; });
    shell.querySelector('[data-control="speed"]').addEventListener('change', event => { video.playbackRate = Number(event.target.value); });
    const qualityButton = shell.querySelector('[data-control="quality-menu"]');
    const qualityLabel = shell.querySelector('[data-quality-label]');
    const qualityMenu = shell.querySelector('.quality-menu');
    let selectedQuality = 0;
    const switchSource = next => {
      if (!next || next.url === video.currentSrc) return;
      const currentTime = video.currentTime;
      const wasPlaying = !video.paused;
      video.src = next.url;
      video.load();
      video.addEventListener('loadedmetadata', () => { video.currentTime = Math.min(currentTime, video.duration || currentTime); if (wasPlaying) video.play(); }, { once: true });
    };
    const renderQualityMenu = () => {
      qualityMenu.innerHTML = sources.map((source, index) => `<button type="button" role="menuitemradio" aria-checked="${index === selectedQuality}" data-quality-index="${index}">${source.label}</button>`).join('');
      qualityLabel.textContent = sources[selectedQuality]?.label || 'Quality';
    };
    qualityButton.addEventListener('click', event => {
      event.stopPropagation();
      const open = qualityMenu.classList.toggle('show');
      qualityButton.setAttribute('aria-expanded', String(open));
      showControls();
    });
    qualityMenu.addEventListener('click', event => {
      const option = event.target.closest('[data-quality-index]');
      if (!option) return;
      event.stopPropagation();
      selectedQuality = Number(option.dataset.qualityIndex);
      renderQualityMenu();
      qualityMenu.classList.remove('show');
      qualityButton.setAttribute('aria-expanded', 'false');
      switchSource(sources[selectedQuality]);
    });
    if (videoData.processingStatus === 'queued' || videoData.processingStatus === 'processing') {
      window.playerProcessingTimer = setInterval(async () => {
        try {
          const response = await fetch(`/api/videos/${videoData._id}/status`);
          if (!response.ok) return;
          const fresh = await response.json();
          if (fresh.sources?.length > sources.length) {
            sources = fresh.sources;
            selectedQuality = 0;
            renderQualityMenu();
            switchSource(sources[0]);
            window.showToast?.(`${sources[0].label} quality is ready`);
          }
          if (fresh.processingStatus === 'ready' || fresh.processingStatus === 'failed') clearInterval(window.playerProcessingTimer);
        } catch (_) {}
      }, 10000);
    }
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
    shell.addEventListener('click', event => { if (!event.target.closest('.quality-control')) { qualityMenu.classList.remove('show'); qualityButton.setAttribute('aria-expanded', 'false'); } });
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
    syncDuration();
    showControls();
  };

  document.addEventListener('submit', async event => {
    if (event.target.id !== 'uploadForm') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const form = event.target;
    const button = form.querySelector('button');
    const bar = form.querySelector('.progress span');
    const videoFile = form.querySelector('[name="video"]').files[0];
    button.disabled = true;
    button.textContent = 'Uploading…';
    const data = new FormData(form);
    try {
      if (!videoFile) throw new Error('Please select a video first.');
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      xhr.setRequestHeader('x-admin-password', sessionStorage.getItem('adminPassword') || '');
      xhr.upload.onprogress = progress => { if (progress.lengthComputable) bar.style.width = `${progress.loaded / progress.total * 100}%`; };
      xhr.onload = () => {
        button.disabled = false;
        if (xhr.status === 201) { window.showToast?.('Upload complete. Video will appear when fully ready.'); history.pushState({}, '', '/admin'); window.dispatchEvent(new PopStateEvent('popstate')); }
        else { button.textContent = 'Upload video'; let message=`Upload failed (${xhr.status})`;try{message=JSON.parse(xhr.responseText).error||message}catch(_){}window.showToast(message); }
      };
      xhr.onerror = () => { button.disabled = false; button.textContent = 'Upload video'; window.showToast?.('Network error'); };
      xhr.send(data);
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Upload video';
      window.showToast(error.message || 'Upload could not be started.');
    }
  }, true);
})();
