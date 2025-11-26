class InstantKaraokeApp {
    constructor() {
        this.currentSession = null;
        this.audioContext = null;
        this.audioBuffers = {};
        this.audioSources = {};
        this.pendingSources = new Set(); // guard against duplicate/racy scheduling
        this.trackStates = {};
        this._pitchEpoch = 0; // increment on each key change to cancel stale schedules
        this._pendingStartTimer = null; // precise start timer for scheduled audio
        this.transport = {
            isPlaying: false,
            startTime: 0,
            pausedAt: 0,
            duration: 0,
            tickerRunning: false,
        };
        this._playerWidthRaf = null;
        this.overlaySizeCache = new WeakMap();
        this.overlayResizeObserver = (typeof ResizeObserver !== 'undefined')
            ? new ResizeObserver((entries) => {
                for (const entry of entries) {
                    if (entry && entry.target) {
                        this.updateKaraokeOverlaySizing(entry.target);
                    }
                }
            })
            : null;
        this.overlayInstanceCounter = 0;
        // Track the active session for polling cancellation/race avoidance
        this.activeSessionId = null;
        this.scheduler = {
            usingChunks: true,
            startTime: 0,
            chunkDuration: 5.0,
            perStem: {}, // stemName -> { nextIndex: 0, scheduled: Set() }
            done: false,
            shouldAutoStart: true, // Allow auto-start only on first chunk
            continuousLoaded: false,
        };
        
        // Key change state
        this.keyOffset = 0; // semitones offset from original key
        this.pitchRatio = 1.0; // playback rate multiplier for pitch changes
        
        this.initializeEventListeners();
        this.initializeAudioContext();
        this.initializeLyrics();

        // Initialize key offset display
        this.updateKeyOffsetDisplay();
    }

    initializeEventListeners() {
        // File input
        const fileInput = document.getElementById('fileInput');
        const chooseFileBtn = document.getElementById('chooseFileBtn');
        fileInput.addEventListener('change', (e) => this.handleFileSelect(e));
        if (chooseFileBtn) {
            chooseFileBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                fileInput.click();
            });
        }

        // Drag and drop
        const uploadArea = document.getElementById('uploadArea');
        uploadArea.addEventListener('dragover', (e) => this.handleDragOver(e));
        uploadArea.addEventListener('dragleave', (e) => this.handleDragLeave(e));
        uploadArea.addEventListener('drop', (e) => this.handleDrop(e));
        uploadArea.addEventListener('click', (e) => {
            // Avoid double prompt if button was clicked
            if (e.target && (e.target.id === 'chooseFileBtn' || e.target.closest('#chooseFileBtn'))) {
                return;
            }
            fileInput.click();
        });

        // Player controls
        document.getElementById('playPauseBtn').addEventListener('click', () => this.togglePlayPause());
        document.getElementById('stopAllBtn').addEventListener('click', () => this.stopAll());
        // removed reset/new-file button
        const seekSlider = document.getElementById('seekSlider');
        seekSlider.addEventListener('input', (e) => this.onSeekInput(e));
        seekSlider.disabled = true; // enable when continuous stems ready

        // Key change controls
        document.getElementById('keyUpBtn').addEventListener('click', () => this.changeKey(1));
        document.getElementById('keyDownBtn').addEventListener('click', () => this.changeKey(-1));

        // Advanced toggle (switch-style)
        this.isAdvanced = false;
        this.originalNonVocalVolumes = {}; // stemName -> number
        const advToggle = document.getElementById('advancedToggle');
        const advSwitch = document.getElementById('advancedToggleSwitch');
        if (advToggle && advSwitch) {
            const updateSwitchUI = () => {
                if (this.isAdvanced) advSwitch.classList.add('active'); else advSwitch.classList.remove('active');
            };
            updateSwitchUI();
            advToggle.addEventListener('click', () => {
                this.isAdvanced = !this.isAdvanced;
                updateSwitchUI();
                this.applyAdvancedVisibility(true);
            });
        }

        // Tabs and YouTube UI
        this.setupTabs();
        this.setupYouTubeSearch();
        this.setupRefineSearch();
        // Refine search is lyrics-only and disabled until a song is chosen
        this.setRefineSearchEnabled(false);
        // Lyrics: Word-level toggle button
        const wordToggle = document.getElementById('lyricsWordLevelToggleBtn');
        if (wordToggle) {
            wordToggle.addEventListener('click', () => this.toggleWordLevel());
        }
        // Lyrics: Upload .lrc file
        const uploadLyricsBtn = document.getElementById('uploadLyricsBtn');
        const lyricsFileInput = document.getElementById('lyricsFileInput');
        if (uploadLyricsBtn && lyricsFileInput) {
            uploadLyricsBtn.addEventListener('click', (e) => {
                e.preventDefault();
                if (lyricsFileInput) lyricsFileInput.click();
            });
            lyricsFileInput.addEventListener('change', (e) => this.handleLyricsFileSelect(e));
        }

        if (typeof window !== 'undefined') {
            window.addEventListener('resize', () => this.schedulePlayerWidthUpdate());
        }
    }

    // Try to extract a YouTube video ID from a string (URL or raw ID)
    parseYouTubeVideoId(input) {
        try {
            const s = String(input || '').trim();
            if (!s) return null;
            // Plain 11-char ID
            const idRegex = /^[A-Za-z0-9_-]{11}$/;
            if (idRegex.test(s)) return s;
            // URL forms
            const url = new URL(s);
            const host = (url.hostname || '').replace(/^www\./, '').toLowerCase();
            let candidate = null;
            if (host === 'youtu.be') {
                candidate = (url.pathname || '').split('/').filter(Boolean)[0] || null;
            } else if (host.endsWith('youtube.com')) {
                const pathname = (url.pathname || '');
                const parts = pathname.split('/').filter(Boolean);
                if (pathname === '/watch') {
                    candidate = url.searchParams.get('v');
                } else if (parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'embed' || parts[0] === 'v') {
                    candidate = parts[1] || null;
                }
            }
            if (candidate && idRegex.test(candidate)) return candidate;
            return null;
        } catch (_) { return null; }
    }

    // Heuristic split on a YouTube title to infer artist and song title
    splitArtistTitle(fullTitle) {
        try {
            let t = String(fullTitle || '').trim();
            if (!t) return { artist: '', title: '' };
            // Remove bracketed/parenthetical trailer like (Official Video), [Lyrics], etc.
            t = t.replace(/\s*[\[(\{][^\])\}]*[\])\}]\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
            // Common separators
            const seps = [' - ', ' — ', ' – ', ' | ', ': '];
            for (const sep of seps) {
                const idx = t.indexOf(sep);
                if (idx > 0 && idx < t.length - sep.length) {
                    const artist = t.slice(0, idx).trim();
                    const title = t.slice(idx + sep.length).trim();
                    if (artist && title) return { artist, title };
                }
            }
            // Fallback: try splitting on hyphen surrounded by spaces
            const hy = t.split(/\s-\s/);
            if (hy.length >= 2) {
                const artist = hy.shift().trim();
                const title = hy.join(' - ').trim();
                return { artist, title };
            }
            return { artist: '', title: t };
        } catch (_) { return { artist: '', title: '' }; }
    }

    // Fetch video metadata (title/author) from YouTube oEmbed (with fallback)
    async fetchVideoMetadata(videoId) {
        const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`;
        const noembedUrl = `https://noembed.com/embed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
        const tryFetch = async (url) => {
            try {
                const res = await fetch(url, { mode: 'cors' });
                if (!res.ok) throw new Error('bad status');
                return await res.json();
            } catch (_) { return null; }
        };
        let data = await tryFetch(oembedUrl);
        if (!data) data = await tryFetch(noembedUrl);
        if (!data) return { title: '', artist: '' };
        const rawTitle = (data.title || '').toString();
        const author = (data.author_name || '').toString();
        const split = this.splitArtistTitle(rawTitle);
        const artist = split.artist || author || '';
        const title = split.title || rawTitle || '';
        return { title, artist };
    }

    initializeLyrics() {
        this.lyrics = {
            entries: [],
            activeIndex: -1,
            loading: false,
            offset: 0.0,
            currentBlockStart: 0,
            _lastRenderedBlockStart: -1,
            _countdown: { active: false, targetTime: 0, side: 'right' },
            wordLevelEnabled: true,
        };
        this.lyricsContainer = document.getElementById('lyricsContainer');
    }

    async handleLyricsFileSelect(event) {
        try {
            const input = event.target;
            const file = input && input.files && input.files[0];
            if (!file) return;
            if (!/\.lrc$/i.test(file.name)) {
                this.showError('Please select a .lrc lyrics file.');
                return;
            }
            const text = await file.text();
            // Apply uploaded lyrics immediately
            this.parseAndSetLyrics(text || '');
            // Reset offset on new lyrics
            this.resetLyricsOffset();
            // Update karaoke overlay preview
            this.updateKaraokeOverlay(-1);
        } catch (err) {
            this.showError(err && err.message ? err.message : 'Failed to load lyrics file');
        } finally {
            // Clear input so same file can be re-selected later
            try { event.target.value = ''; } catch (_) {}
        }
    }

    // Determine if current lyrics have any word-level timestamps
    hasWordLevelLyrics() {
        try {
            const entries = this.lyrics?.entries || [];
            return entries.some(e => e && Array.isArray(e.words) && e.words.length > 0);
        } catch (_) { return false; }
    }

    // Update the Word-level toggle button state (label + disabled)
    updateWordLevelToggleUI() {
        const btn = document.getElementById('lyricsWordLevelToggleBtn');
        if (!btn) return;
        const hasWord = this.hasWordLevelLyrics();
        btn.disabled = !hasWord;
        const on = !!(this.lyrics && this.lyrics.wordLevelEnabled && hasWord);
        btn.textContent = `Word-level: ${on ? 'On' : 'Off'}`;
    }

    // Toggle word-level karaoke highlighting
    toggleWordLevel() {
        try {
            // Only allow toggling if we actually have word-level lyrics
            if (!this.hasWordLevelLyrics()) {
                this.updateWordLevelToggleUI();
                return;
            }
            if (!this.lyrics) this.initializeLyrics();
            // default to enabled
            if (typeof this.lyrics.wordLevelEnabled !== 'boolean') {
                this.lyrics.wordLevelEnabled = true;
            }
            this.lyrics.wordLevelEnabled = !this.lyrics.wordLevelEnabled;
            const btn = document.getElementById('lyricsWordLevelToggleBtn');
            if (btn) {
                btn.textContent = `Word-level: ${this.lyrics.wordLevelEnabled ? 'On' : 'Off'}`;
                btn.disabled = !this.hasWordLevelLyrics();
            }
            // Re-render overlay to reflect mode change
            this.updateKaraokeOverlay(this.lyrics.activeIndex);
        } catch (_) { /* ignore */ }
    }

    resetLyricsOffset() {
        if (!this.lyrics) this.initializeLyrics();
        this.lyrics.offset = 0.0;
        const value = document.getElementById('lyricsOffsetValue');
        if (value) value.textContent = '0.0s';
    }

    async initializeAudioContext() {
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.pitchWorklet = null;

            // Master chain base: stems -> masterGain -> (pitchWorklet|bypass) -> compressor -> softClipper -> destination
            this.masterGain = this.audioContext.createGain();
            this.masterGain.gain.value = 0.6; // headroom

            this.compressor = this.audioContext.createDynamicsCompressor();
            this.compressor.threshold.value = -9;
            this.compressor.knee.value = 12;
            this.compressor.ratio.value = 12;
            this.compressor.attack.value = 0.002;
            this.compressor.release.value = 0.2;
            this.softClipper = this.createSoftClipper(2.5);

            // Try to load AudioWorklet pitch shifter for continuous key shifting
            try {
                await this.audioContext.audioWorklet.addModule('/static/pitch-shifter-processor.js');
                this.pitchWorklet = new AudioWorkletNode(this.audioContext, 'pitch-shifter-processor', {
                    numberOfInputs: 1,
                    numberOfOutputs: 1,
                    outputChannelCount: [2],
                });
                const param = this.pitchWorklet.parameters.get('pitch');
                if (param) param.setValueAtTime(1.0, this.audioContext.currentTime);
                this.masterGain.connect(this.pitchWorklet);
                this.pitchWorklet.connect(this.compressor);
            } catch (err) {
                // Fallback to bypass if worklet not available
                console.warn('Pitch worklet unavailable, bypassing continuous pitch shift:', err);
                this.masterGain.connect(this.compressor);
            }
            this.compressor.connect(this.softClipper);
            this.softClipper.connect(this.audioContext.destination);
        } catch (e) {
            console.error('Web Audio API not supported');
        }
    }

    createSoftClipper(drive = 2.0) {
        const node = this.audioContext.createWaveShaper();
        const curve = new Float32Array(44100);
        const k = drive;
        for (let i = 0; i < curve.length; i++) {
            const x = (i / (curve.length - 1)) * 2 - 1;
            // tanh-like soft clipping
            curve[i] = Math.tanh(k * x) / Math.tanh(k);
        }
        node.curve = curve;
        node.oversample = '4x';
        return node;
    }

    createPitchShifter() {
        // For now, create a simple gain node as a placeholder for pitch shifting
        // We'll implement pitch shifting by restarting sources with modified playback rates
        const pitchNode = this.audioContext.createGain();
        pitchNode.gain.value = 1.0;
        
        // Store current pitch ratio (1.0 = no change)
        this.pitchRatio = 1.0;
        
        return pitchNode;
    }

    handleDragOver(e) {
        e.preventDefault();
        e.currentTarget.classList.add('dragover');
    }

    handleDragLeave(e) {
        e.preventDefault();
        e.currentTarget.classList.remove('dragover');
    }

    handleDrop(e) {
        e.preventDefault();
        e.currentTarget.classList.remove('dragover');
        
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            this.processFile(files[0]);
        }
    }

    handleFileSelect(e) {
        const file = e.target.files[0];
        if (file) {
            this.processFile(file);
        }
    }

    async processFile(file) {
        // Validate file type
        const allowedTypes = ['audio/wav', 'audio/mp3', 'audio/flac', 'audio/m4a', 'audio/ogg'];
        if (!allowedTypes.includes(file.type) && !file.name.match(/\.(wav|mp3|flac|m4a|ogg)$/i)) {
            this.showError('Invalid file type. Please upload a WAV, MP3, FLAC, M4A, or OGG file.');
            return;
        }

        // Show upload progress
        this.showUploadProgress();
        
        try {
            const formData = new FormData();
            formData.append('file', file);

            const response = await fetch('/api/upload', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Upload failed');
            }

            const result = await response.json();
            this.currentSession = result;
            this.activeSessionId = result.session_id;
            // Reset lyrics offset for a new session
            this.resetLyricsOffset();
            // Track latest metadata for lyrics refine defaults
            try {
                const baseName = (file.name || '').replace(/\.[^/.]+$/, '');
                this._latestTitle = baseName || (file.name || '');
                this._latestArtist = '';
            } catch (_) { this._latestTitle = file.name || ''; this._latestArtist = ''; }
            
            // Hide upload progress and show processing
            this.hideUploadProgress();
            this.showProcessingProgress();
            this.scrollPlayerIntoView();
            
            // Create player UI immediately and start polling for chunks
            this.createStemsPlayer();
            this.scheduler.chunkDuration = this.currentSession.chunk_duration || 5.0;
            this.scheduler.shouldAutoStart = true; // Enable auto-start for new session
            this.startPolling();
            this.showPlayerActiveUI();
            
        } catch (error) {
            this.hideUploadProgress();
            this.showError(error.message);
        }
    }

    showUploadProgress() {
        // Hide only the drop area, show progress inside the same section
        const uploadArea = document.getElementById('uploadArea');
        const uploadProgress = document.getElementById('uploadProgress');
        if (uploadArea) uploadArea.style.display = 'none';
        if (uploadProgress) uploadProgress.style.display = 'block';
        
        // Simulate upload progress
        let progress = 0;
        const progressFill = document.getElementById('progressFill');
        const progressText = document.getElementById('progressText');
        
        const interval = setInterval(() => {
            progress += Math.random() * 15;
            if (progress >= 100) {
                progress = 100;
                clearInterval(interval);
            }
            progressFill.style.width = progress + '%';
            progressText.textContent = `Uploading... ${Math.round(progress)}%`;
        }, 200);
    }

    hideUploadProgress() {
        const uploadArea = document.getElementById('uploadArea');
        const uploadProgress = document.getElementById('uploadProgress');
        if (uploadProgress) uploadProgress.style.display = 'none';
        if (uploadArea) uploadArea.style.display = 'block';
    }

    showProcessingProgress() {
        const el = document.getElementById('processingSection');
        if (el) el.style.display = 'flex';
    }

    hideProcessingProgress() {
        document.getElementById('processingSection').style.display = 'none';
    }
    
    scrollPlayerIntoView() {
        try {
            const section = document.getElementById('playerSection');
            if (!section) return;
            const rect = section.getBoundingClientRect();
            const viewportH = window.innerHeight || document.documentElement.clientHeight;
            const mostlyVisible = rect.top >= 0 && rect.bottom <= viewportH;
            if (!mostlyVisible) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (_) {}
    }



    async loadStems() {
        const { session_id, stems } = this.currentSession;
        const stemNames = Object.keys(stems);
        
        // Start playback as soon as the first stem is decoded
        let firstStarted = false;
        
        stemNames.forEach(async (stemName, idx) => {
            const stemData = stems[stemName];
            const audioUrl = this.buildPitchedUrl(`/api/audio/${session_id}/${stemData.filename}`);
            try {
                const response = await fetch(audioUrl, { cache: 'no-store' });
                const arrayBuffer = await response.arrayBuffer();
                const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
                this.audioBuffers[stemName] = audioBuffer;
                const nameLower = (stemName || '').toLowerCase();
                const isVocal = nameLower.includes('voc') || nameLower.includes('vocal') || nameLower === 'vocals' || nameLower === 'sing' || nameLower === 'vocal';
                const defaultEnabled = this.isAdvanced ? true : !isVocal;
                this.trackStates[stemName] = { enabled: defaultEnabled, volume: 1.0, gainNode: null };
                // Update duration if longer
                this.transport.duration = Math.max(this.transport.duration, audioBuffer.duration);
                this.updateDurationLabels();
                
                if (!firstStarted) {
                    firstStarted = true;
                    this.startPlaybackWhenReady();
                }
            } catch (error) {
                console.error(`Failed to load audio: ${audioUrl}`, error);
            }
        });
    }

    startPolling() {
        const sessionId = this.currentSession.session_id;
        const pollToken = sessionId; // capture token to detect stale pollers
        const poll = async () => {
            try {
                const res = await fetch(`/api/status/${sessionId}`);
                const status = await res.json();
                if (status.error) return;
                // If session changed, stop this poller silently
                if (this.activeSessionId !== pollToken) return;
                // First pass: calculate minimum ready chunks and ensure UI exists
                let minReadyChunks = status.stems.length > 0 ? Number.MAX_SAFE_INTEGER : 0;
                
                for (const stemName of status.stems) {
                    const ready = status.ready[stemName] || [];
                    // Ensure stem UI exists
                    if (!document.getElementById(`stem-${stemName}`)) {
                        const el = this.createStemElement(stemName, {});
                        el.id = `stem-${stemName}`;
                        document.getElementById('stemsContainer').appendChild(el);
                        // Enforce current advanced/simple visibility on newly created track
                        this.applyAdvancedVisibility(false);
                    }
                    
                    // Track minimum chunks available across all stems
                    minReadyChunks = Math.min(minReadyChunks, ready.length);
                }
                
                // Second pass: schedule chunks now that we know if we should auto-start
                const shouldAutoStart = this.scheduler.shouldAutoStart && minReadyChunks >= 1;
                
                for (const stemName of status.stems) {
                    const ready = status.ready[stemName] || [];
                    const state = this.scheduler.perStem[stemName] || { nextIndex: 0, scheduled: new Set() };
                    this.scheduler.perStem[stemName] = state;
                    
                    // Schedule chunks if we're playing, or if we should auto-start with enough buffer
                    while (ready.includes(state.nextIndex) && (this.transport.isPlaying || shouldAutoStart)) {
                        // Only schedule if not already scheduled
                        if (!state.scheduled.has(state.nextIndex)) {
                            await this.scheduleChunk(sessionId, stemName, state.nextIndex);
                            state.scheduled.add(state.nextIndex);
                        }
                        state.nextIndex += 1;
                    }
                }
                
                // Auto-start silently when we have enough buffered chunks
                // (previously logged to console)
                

                this.scheduler.done = status.done;
                if (status.done) {
                    // Enable seeking once continuous stems are available
                    document.getElementById('seekSlider').disabled = false;
                    // Load continuous stems once, then optionally switch playback mode on next seek
                    if (!this.scheduler.continuousLoaded) {
                        this.scheduler.continuousLoaded = true;
                        for (const stemName of status.stems) {
                            this.loadContinuousStem(sessionId, stemName).catch(() => {});
                        }
                    }

                }
                if (!status.done && this.activeSessionId === pollToken) {
                    setTimeout(poll, 1000);
                }
            } catch (e) {
                if (this.activeSessionId === pollToken) setTimeout(poll, 1500);
            }
        };
        poll();
    }


    async loadContinuousStem(sessionId, stemName) {
        const url = this.buildPitchedUrl(`/api/audio/${sessionId}/${stemName}.wav`);
        const res = await fetch(url, { cache: 'no-store' });
        const buf = await res.arrayBuffer();
        const audioBuffer = await this.audioContext.decodeAudioData(buf);
        this.audioBuffers[stemName] = audioBuffer;
        const nameLower = (stemName || '').toLowerCase();
        const isVocal = nameLower.includes('voc') || nameLower.includes('vocal') || nameLower === 'vocals' || nameLower === 'sing' || nameLower === 'vocal';
        const defaultEnabled = this.isAdvanced ? true : !isVocal;
        this.trackStates[stemName] = this.trackStates[stemName] || { enabled: defaultEnabled, volume: 1.0, gainNode: null };
        this.transport.duration = Math.max(this.transport.duration, audioBuffer.duration);
        this.updateDurationLabels();
    }

    async scheduleChunk(sessionId, stemName, chunkIndex, epochOverride = null) {
        // Check if already scheduled to prevent duplicates
        const key = `${stemName}_${chunkIndex}`;
        if (this.audioSources[key]) {
            console.warn(`Chunk ${chunkIndex} for ${stemName} already scheduled`);
            return;
        }
        // Prevent racy duplicate scheduling in parallel
        const pendingKey = `P_${key}`;
        if (this.pendingSources.has(pendingKey)) return;
        this.pendingSources.add(pendingKey);

        const url = this.buildPitchedUrl(`/api/audio/${sessionId}/chunk_${String(chunkIndex).padStart(3, '0')}_${stemName}.wav`);
        // Capture current pitch epoch to invalidate stale results
        const epoch = (epochOverride == null) ? (this._pitchEpoch || 0) : epochOverride;
        const res = await fetch(url, { cache: 'no-store' });
        const buf = await res.arrayBuffer();
        // If epoch changed while we fetched, abort quietly
        if (epoch !== (this._pitchEpoch || 0)) { this.pendingSources.delete(pendingKey); return; }
        const audioBuffer = await this.audioContext.decodeAudioData(buf);
        if (epoch !== (this._pitchEpoch || 0)) { this.pendingSources.delete(pendingKey); return; }
        const nameLower = (stemName || '').toLowerCase();
        const isVocal = nameLower.includes('voc') || nameLower.includes('vocal') || nameLower === 'vocals' || nameLower === 'sing' || nameLower === 'vocal';
        const defaultEnabled = this.isAdvanced ? true : !isVocal;
        const state = this.trackStates[stemName] || { enabled: defaultEnabled, volume: 0.7, gainNode: null };
        this.trackStates[stemName] = state;
        // Create a persistent gain node per stem and keep it connected once
        if (!state.gainNode) {
            state.gainNode = this.audioContext.createGain();
            state.gainNode.gain.value = state.enabled ? state.volume : 0;
            // Route through master chain
            state.gainNode.connect(this.masterGain);
        }
        const source = this.audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(state.gainNode);
        // Only schedule chunk if transport should be playing
        if (!this.transport.isPlaying && this.scheduler.shouldAutoStart) {
            // Delay a little to allow multiple stems' first chunks to queue for sync
            const now = this.audioContext.currentTime + 0.25;
            this.transport.isPlaying = true;
            this.transport.startTime = now;
            this.transport.pausedAt = 0;
            // Hide processing overlay on first audio start
            this.hideProcessingProgress();
            this.updatePlayPauseUI();
            this.startTransportTicker();
            this.scheduler.startTime = now;
            this.scheduler.shouldAutoStart = false; // Prevent further auto-starts
            // Start media playback in sync with audio when first chunk triggers auto-start
            this.syncMediaStart(now, 0);
        } else if (!this.transport.isPlaying) {
            // Don't schedule if transport is paused/stopped
            return;
        }
        // Compute planned start time aligned to transport, but avoid starting in the past
        const plannedStart = this.scheduler.startTime + (chunkIndex * this.scheduler.chunkDuration);
        const now = this.audioContext.currentTime;
        const minLead = 0.02; // seconds
        let when = plannedStart;
        let srcOffset = 0;
        if (when < now + minLead) {
            // We are late; start ASAP with an offset so it stays in sync
            srcOffset = Math.max(0, now - plannedStart);
            // If the whole chunk duration already passed, skip scheduling
            if (audioBuffer && srcOffset >= audioBuffer.duration - 0.005) {
                this.pendingSources.delete(pendingKey);
                return;
            }
            when = now + 0.005;
        }
        try {
            if (srcOffset > 0) {
                source.start(when, srcOffset);
            } else {
                source.start(when);
            }
        } catch (_) {
            // Fallback: if start fails, skip this chunk
            this.pendingSources.delete(pendingKey);
            return;
        }
        // Track source so we can stop on pause/stop
        this.audioSources[key] = source;
        // Cleanup tracking when source ends
        try { source.onended = () => { delete this.audioSources[key]; }; } catch (_) {}
        this.pendingSources.delete(pendingKey);
        // Update duration based on highest scheduled chunk index
        this.transport.duration = Math.max(this.transport.duration, (chunkIndex + 1) * this.scheduler.chunkDuration);
        this.updateDurationLabels();
        this.updateMasterAutoGain();
    }

    async rescheduleChunksFromTime(resumeTime, epochOverride = null) {
        const sessionId = this.currentSession.session_id;
        const resumeChunkIndex = Math.floor(resumeTime / this.scheduler.chunkDuration);
        const offsetInChunk = resumeTime % this.scheduler.chunkDuration;
        const epoch = (epochOverride == null) ? (this._pitchEpoch || 0) : epochOverride;
        let earliestStart = Infinity;
        
        // For each stem, reschedule chunks starting from resumeChunkIndex
        for (const [stemName, stemState] of Object.entries(this.scheduler.perStem)) {
            for (let chunkIndex = resumeChunkIndex; chunkIndex < stemState.nextIndex; chunkIndex++) {
                const key = `${stemName}_${chunkIndex}`;
                
                // Skip if already scheduled
                if (this.audioSources[key]) {
                    continue;
                }
                
                try {
                    const url = this.buildPitchedUrl(`/api/audio/${sessionId}/chunk_${String(chunkIndex).padStart(3, '0')}_${stemName}.wav`);
                    const res = await fetch(url, { cache: 'no-store' });
                    const buf = await res.arrayBuffer();
                    if (epoch !== (this._pitchEpoch || 0)) { continue; }
                    const audioBuffer = await this.audioContext.decodeAudioData(buf);
                    if (epoch !== (this._pitchEpoch || 0)) { continue; }
                    
                    const state = this.trackStates[stemName];
                    if (!state || !state.gainNode) continue;
                    
                    const source = this.audioContext.createBufferSource();
                    source.buffer = audioBuffer;
                    source.connect(state.gainNode);
                    
                    // Start time for this chunk, accounting for resume offset and late scheduling
                    let startTime = this.scheduler.startTime + (chunkIndex * this.scheduler.chunkDuration);
                    let sourceOffset = 0;
                    if (chunkIndex === resumeChunkIndex) {
                        // First chunk after resume - start with offset
                        sourceOffset = offsetInChunk;
                    }
                    // If we are behind schedule, add additional offset so playback stays in sync
                    const now = this.audioContext.currentTime;
                    const minLead = 0.02; // seconds
                    if (startTime < now + minLead) {
                        const extra = Math.max(0, now - startTime);
                        sourceOffset += extra;
                        startTime = now + 0.005;
                    }
                    // Skip if offset exceeds buffer duration
                    if (audioBuffer && sourceOffset >= audioBuffer.duration - 0.005) {
                        continue;
                    }
                    try {
                        source.start(startTime, sourceOffset);
                    } catch (_) {
                        continue;
                    }
                    if (startTime < earliestStart) earliestStart = startTime;
                    this.audioSources[key] = source;
                    try { source.onended = () => { delete this.audioSources[key]; }; } catch (_) {}
                    stemState.scheduled.add(chunkIndex);
                } catch (e) {
                    console.warn(`Failed to reschedule chunk ${chunkIndex} for ${stemName}`);
                }
            }
        }
        return Number.isFinite(earliestStart) ? earliestStart : null;
    }

    async resumeChunkScheduling() {
        if (!this.currentSession) return;
        
        const sessionId = this.currentSession.session_id;
        try {
            const res = await fetch(`/api/status/${sessionId}`);
            const status = await res.json();
            if (status.error) return;
            
            // Schedule any chunks that became ready while paused
            for (const stemName of status.stems) {
                const ready = status.ready[stemName] || [];
                const state = this.scheduler.perStem[stemName];
                if (!state) continue;
                
                while (ready.includes(state.nextIndex) && this.transport.isPlaying) {
                    // Only schedule if not already scheduled
                    if (!state.scheduled.has(state.nextIndex)) {
                        await this.scheduleChunk(sessionId, stemName, state.nextIndex);
                        state.scheduled.add(state.nextIndex);
                    }
                    state.nextIndex += 1;
                }
            }
        } catch (e) {
            console.warn('Failed to resume chunk scheduling:', e);
        }
    }

    createStemsPlayer() {
        document.getElementById('playerSection').style.display = 'block';

        // Hide controls/lyrics until playback actually starts
        const controls = document.getElementById('playerControls');
        const lyricsPane = document.getElementById('lyricsPane');
        const emptyState = document.getElementById('playerEmptyState');
        if (controls) controls.style.display = 'none';
        if (lyricsPane) lyricsPane.style.display = 'none';
        if (emptyState) emptyState.style.display = 'block';

        const stemsContainer = document.getElementById('stemsContainer');
        stemsContainer.innerHTML = '';
        // stems will appear dynamically as they become ready

        // Ensure visibility mode applied to newly created stems once they arrive
        setTimeout(() => this.applyAdvancedVisibility(false), 0);
    }

    showPlayerActiveUI() {
        const controls = document.getElementById('playerControls');
        const lyricsPane = document.getElementById('lyricsPane');
        const emptyState = document.getElementById('playerEmptyState');
        if (controls) controls.style.display = 'flex';
        if (lyricsPane) lyricsPane.style.display = '';
        if (emptyState) emptyState.style.display = 'none';
        // Wire up lyrics offset controls once visible
        const minus = document.getElementById('lyricsOffsetMinus');
        const plus = document.getElementById('lyricsOffsetPlus');
        const value = document.getElementById('lyricsOffsetValue');
        if (minus && plus && value && !this._lyricsOffsetBound) {
            minus.addEventListener('click', () => {
                this.lyrics.offset = (this.lyrics.offset || 0) - 0.5;
                value.textContent = `${this.lyrics.offset.toFixed(1)}s`;
                // Re-render to reflect new alignment immediately
                this.updateLyricsAtTime(this.getCurrentTime());
            });
            plus.addEventListener('click', () => {
                this.lyrics.offset = (this.lyrics.offset || 0) + 0.5;
                value.textContent = `${this.lyrics.offset.toFixed(1)}s`;
                this.updateLyricsAtTime(this.getCurrentTime());
            });
            value.textContent = `${(this.lyrics.offset || 0).toFixed(1)}s`;
            this._lyricsOffsetBound = true;
        }
        // Prefill refine search inputs with latest metadata
        const artistInput = document.getElementById('refineArtistInput');
        const titleInput = document.getElementById('refineTitleInput');
        if (artistInput && titleInput) {
            if (typeof this._latestArtist === 'string') artistInput.value = this._latestArtist;
            if (typeof this._latestTitle === 'string') titleInput.value = this._latestTitle;
        }
        // Enable refine search once a song is chosen
        this.setRefineSearchEnabled(true);
        // Sync word-level toggle UI
        this.updateWordLevelToggleUI();
    }

    createStemElement(stemName, stemData) {
        const trackDiv = document.createElement('div');
        trackDiv.className = 'track';
        
        const trackHeader = document.createElement('div');
        trackHeader.className = 'track-header';
        
        const trackName = document.createElement('div');
        trackName.className = 'track-name';
        trackName.textContent = stemName;
        
        const trackToggle = document.createElement('div');
        trackToggle.className = 'track-toggle';
        
        const toggleSwitch = document.createElement('div');
        const nameLower = (stemName || '').toLowerCase();
        const isVocal = nameLower.includes('voc') || nameLower.includes('vocal') || nameLower === 'vocals' || nameLower === 'sing' || nameLower === 'vocal';
        const defaultEnabled = this.isAdvanced ? true : !isVocal;
        toggleSwitch.className = 'toggle-switch' + (defaultEnabled ? ' active' : '');
        toggleSwitch.onclick = (event) => this.toggleStem(event, stemName);
        
        const toggleLabel = document.createElement('span');
        toggleLabel.textContent = defaultEnabled ? 'Enabled' : 'Disabled';
        
        trackToggle.appendChild(toggleSwitch);
        trackToggle.appendChild(toggleLabel);
        trackHeader.appendChild(trackName);
        trackHeader.appendChild(trackToggle);
        
        const trackVolume = document.createElement('div');
        trackVolume.className = 'track-volume';
        
        const volumeSlider = document.createElement('input');
        volumeSlider.type = 'range';
        volumeSlider.className = 'volume-slider';
        volumeSlider.min = '0';
        volumeSlider.max = '100';
        volumeSlider.value = '100';
        volumeSlider.oninput = (e) => this.setStemVolume(stemName, e.target.value / 100);
        
        const volumeLabel = document.createElement('span');
        volumeLabel.className = 'volume-label';
        volumeLabel.textContent = '100%';
        
        volumeSlider.oninput = (e) => {
            const volume = e.target.value / 100;
            this.setStemVolume(stemName, volume);
            volumeLabel.textContent = `${e.target.value}%`;
        };
        
        trackVolume.appendChild(volumeSlider);
        trackVolume.appendChild(volumeLabel);
        
        trackDiv.appendChild(trackHeader);
        trackDiv.appendChild(trackVolume);
        
        // Apply visibility rules for simple/advanced modes
        trackDiv.dataset.stemName = stemName;
        return trackDiv;
    }

    createTrackElement(chunkIndex, stemName, stemData) {
        const trackDiv = document.createElement('div');
        trackDiv.className = 'track';
        
        const trackHeader = document.createElement('div');
        trackHeader.className = 'track-header';
        
        const trackName = document.createElement('div');
        trackName.className = 'track-name';
        trackName.textContent = stemName;
        
        const trackToggle = document.createElement('div');
        trackToggle.className = 'track-toggle';
        
        const toggleSwitch = document.createElement('div');
        const nameLower = (stemName || '').toLowerCase();
        const isVocal = nameLower.includes('voc') || nameLower.includes('vocal') || nameLower === 'vocals' || nameLower === 'sing' || nameLower === 'vocal';
        const defaultEnabled = this.isAdvanced ? true : !isVocal;
        toggleSwitch.className = 'toggle-switch' + (defaultEnabled ? ' active' : '');
        toggleSwitch.onclick = (event) => this.toggleTrack(event, chunkIndex, stemName);
        
        const toggleLabel = document.createElement('span');
        toggleLabel.textContent = defaultEnabled ? 'Enabled' : 'Disabled';
        
        trackToggle.appendChild(toggleSwitch);
        trackToggle.appendChild(toggleLabel);
        trackHeader.appendChild(trackName);
        trackHeader.appendChild(trackToggle);
        
        const trackVolume = document.createElement('div');
        trackVolume.className = 'track-volume';
        
        const volumeSlider = document.createElement('input');
        volumeSlider.type = 'range';
        volumeSlider.className = 'volume-slider';
        volumeSlider.min = '0';
        volumeSlider.max = '100';
        volumeSlider.value = '100';
        volumeSlider.oninput = (e) => this.setTrackVolume(chunkIndex, stemName, e.target.value / 100);
        
        const volumeLabel = document.createElement('span');
        volumeLabel.className = 'volume-label';
        volumeLabel.textContent = '100%';
        
        volumeSlider.oninput = (e) => {
            const volume = e.target.value / 100;
            this.setTrackVolume(chunkIndex, stemName, volume);
            volumeLabel.textContent = `${e.target.value}%`;
        };
        
        trackVolume.appendChild(volumeSlider);
        trackVolume.appendChild(volumeLabel);
        
        trackDiv.appendChild(trackHeader);
        trackDiv.appendChild(trackVolume);
        
        return trackDiv;
    }

    toggleStem(event, stemName) {
        const state = this.trackStates[stemName];
        
        if (state) {
            state.enabled = !state.enabled;
            
            // Update gain node to immediately mute/unmute
            if (state.gainNode) {
                state.gainNode.gain.value = state.enabled ? state.volume : 0;
            }
            
            // Update UI
            const toggleSwitch = event.currentTarget.closest('.track-toggle').querySelector('.toggle-switch');
            const toggleLabel = event.currentTarget.closest('.track-toggle').querySelector('span');
            
            if (state.enabled) {
                toggleSwitch.classList.add('active');
                toggleLabel.textContent = 'Enabled';
            } else {
                toggleSwitch.classList.remove('active');
                toggleLabel.textContent = 'Disabled';
            }
        }
    }

    setStemVolume(stemName, volume) {
        const state = this.trackStates[stemName];
        
        if (state) {
            state.volume = volume;
            if (state.gainNode) {
                // Only apply volume if the stem is enabled
                state.gainNode.gain.value = state.enabled ? volume : 0;
            }
        }
    }

    changeKey(semitonesChange) {
        // Update key offset
        this.keyOffset += semitonesChange;
        this.keyOffset = Math.max(-12, Math.min(12, this.keyOffset));
        this.pitchRatio = Math.pow(2, this.keyOffset / 12);
        this.updateKeyOffsetDisplay();
        // Stop any preview and restore main gain if ducked
        if (this._previewSource) {
            try { this._previewSource.stop(); } catch (_) {}
            this._previewSource = null;
        }
        if (this._restoreMasterGain) {
            try { this._restoreMasterGain(); } catch (_) {}
            this._restoreMasterGain = null;
        }
        // Reload audio via pitched endpoint and resume
        const resumeAt = this.getCurrentTime();
        const wasPlaying = this.transport.isPlaying;
        // Increment pitch epoch to invalidate any in-flight schedules for old pitch
        this._pitchEpoch = (this._pitchEpoch || 0) + 1;
        const epoch = this._pitchEpoch;
        this.stopAll();
        // Clear any pending schedule keys
        if (this.pendingSources) this.pendingSources.clear();
        this.audioSources = {};
        const sessionId = (this.currentSession && this.currentSession.session_id) || null;
        const reloadContinuous = !!this.scheduler.continuousLoaded;
        if (reloadContinuous && sessionId) {
            // Force continuous mode and reload all stems pitched BEFORE resuming to avoid mixed pitch
            this.scheduler.usingChunks = false;
            const stemNames = Object.keys(this.trackStates || {});
            Promise.all(stemNames.map(name => this.loadContinuousStem(sessionId, name))).then(() => {
                this.transport.pausedAt = resumeAt;
                if (wasPlaying) {
                    if (!this.transport.isPlaying) this.togglePlayPause();
                } else {
                    this.updatePlayPauseUI();
                }
            }).catch(() => {
                this.transport.pausedAt = resumeAt;
                this.updatePlayPauseUI();
            });
        } else {
            // Chunk mode: clear and wait for pitch-shifted chunks before resuming playback
            this.scheduler.usingChunks = true;
            this.scheduler.shouldAutoStart = false; // prevent auto-start with stale buffers
            const resumeChunkIndex = Math.floor(resumeAt / this.scheduler.chunkDuration);
            const offsetInChunk = resumeAt % this.scheduler.chunkDuration;

            // Reset per-stem scheduling state to the resume point
            const stems = Object.keys(this.scheduler.perStem || {});
            stems.forEach((stemName) => {
                const state = this.scheduler.perStem[stemName] || { nextIndex: 0, scheduled: new Set() };
                state.nextIndex = resumeChunkIndex + 1; // ensure first resume chunk gets (re)scheduled
                if (state.scheduled) state.scheduled.clear(); else state.scheduled = new Set();
                this.scheduler.perStem[stemName] = state;
            });

            this.transport.pausedAt = resumeAt;

            if (wasPlaying) {
                // Pre-schedule first pitched chunk(s) at the correct resume time, then start transport
                const now = this.audioContext.currentTime + 0.25;
                this.scheduler.startTime = now - (resumeChunkIndex * this.scheduler.chunkDuration) - offsetInChunk;
                // Schedule the first available chunks using pitched endpoint with proper offsets
                this.rescheduleChunksFromTime(resumeAt, epoch).then((firstStartAt) => {
                    // If a precise first start time is available, align transport exactly
                    const plannedStart = (typeof firstStartAt === 'number' && isFinite(firstStartAt)) ? firstStartAt : now;
                    const delayMs = Math.max(0, (plannedStart - this.audioContext.currentTime) * 1000 - 2);
                    // Clear any previous pending precise start
                    if (this._pendingStartTimer) { try { clearTimeout(this._pendingStartTimer); } catch (_) {} this._pendingStartTimer = null; }
                    this._pendingStartTimer = setTimeout(() => {
                        // Avoid starting if paused/stopped in the meantime
                        if (!this.currentSession || this._pitchEpoch !== epoch) return;
                        this.transport.isPlaying = true;
                        // Ensure transport timeline matches the scheduled chunks
                        this.transport.startTime = plannedStart - this.transport.pausedAt;
                        this.updatePlayPauseUI();
                        this.startTransportTicker();
                        this.resumeChunkScheduling();
                        this.hideProcessingProgress();
                        this.syncMediaStart(plannedStart, this.transport.pausedAt);
                        this._pendingStartTimer = null;
                    }, Math.max(0, delayMs));
                }).catch(() => {
                    // If scheduling fails, stay paused but update UI
                    this.updatePlayPauseUI();
                });
            } else {
                // Stay paused; playback will use pitched endpoints when started later
                this.updatePlayPauseUI();
            }
        }
    }

    async fetchPitchPreview() {
        try {
            if (!this.currentSession || !this.currentSession.session_id) return;
            const sessionId = this.currentSession.session_id;
            const currentTime = this.getCurrentTime();
            const start = Math.max(0, currentTime);
            const dur = 2.5; // short, responsive snippet
            const ts = Date.now();
            const url = `/api/pitch_preview/${encodeURIComponent(sessionId)}?semitones=${encodeURIComponent(this.keyOffset)}&start=${encodeURIComponent(start)}&dur=${encodeURIComponent(dur)}&ts=${encodeURIComponent(ts)}`;
            // Ensure audio context is running after user gesture
            if (this.audioContext && this.audioContext.state === 'suspended') {
                try { await this.audioContext.resume(); } catch (_) {}
            }
            const res = await fetch(url, { cache: 'no-store' });
            if (!res.ok) return;
            const arr = await res.arrayBuffer();
            const buf = await this.audioContext.decodeAudioData(arr);
            // Play shifted preview clearly: stop prior preview and duck main mix
            // Stop any prior preview to avoid overlap and restore ducking if active
            if (this._previewSource) {
                try { this._previewSource.stop(); } catch (_) {}
                this._previewSource = null;
            }
            if (this._restoreMasterGain) {
                try { this._restoreMasterGain(); } catch (_) {}
                this._restoreMasterGain = null;
            }
            const src = this.audioContext.createBufferSource();
            src.buffer = buf;
            const g = this.audioContext.createGain();
            g.gain.value = 1.0;
            // Route preview to bypass masterGain (so ducking does not mute it)
            // Chain: preview -> gain -> compressor -> softClipper -> destination
            src.connect(g).connect(this.compressor);
            const when = this.audioContext.currentTime + 0.02;
            src.start(when);
            this._previewSource = src;
            // Duck the main mix during preview
            const prevMaster = this.masterGain.gain.value;
            this.masterGain.gain.value = 0.0;
            this._restoreMasterGain = () => {
                if (this.masterGain) this.masterGain.gain.value = prevMaster;
            };
            src.onended = () => {
                if (this._restoreMasterGain) { try { this._restoreMasterGain(); } catch (_) {} this._restoreMasterGain = null; }
            };
            // Auto-stop after buffer duration just in case
            const stopAt = when + buf.duration + 0.1;
            src.stop(stopAt);
            // Safety restore if onended is missed
            setTimeout(() => {
                if (this._restoreMasterGain) { try { this._restoreMasterGain(); } catch (_) {} this._restoreMasterGain = null; }
            }, Math.max(50, (stopAt - this.audioContext.currentTime) * 1000));
        } catch (_) {
            // ignore preview failures
        }
    }

    updateKeyOffsetDisplay() {
        const display = document.getElementById('keyOffsetDisplay');
        if (display) {
            const sign = this.keyOffset > 0 ? '+' : '';
            display.textContent = `Key: ${sign}${this.keyOffset}`;
        }
    }


    startPlaybackWhenReady() {
        // Start continuous playback of available stems; others join when decoded
        this.stopAll();
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }
        const now = this.audioContext.currentTime + 0.15; // small delay to allow initial stems to be ready
        this.transport.startTime = now;
        this.transport.isPlaying = true;
        this.transport.pausedAt = 0;
        // Continuous mode start: hide processing overlay if still visible
        this.hideProcessingProgress();
        this.updatePlayPauseUI();
        this.startTransportTicker();
        this.startContinuousPlayback(0);
        this.showPlayerActiveUI();
        // Autoplay media video if present
        this.syncMediaStart(now, 0);
    }

    startContinuousPlayback(offset = 0) {
        const now = this.audioContext.currentTime + 0.05;
        
        for (const [stemName, buffer] of Object.entries(this.audioBuffers)) {
            const state = this.trackStates[stemName];
            if (!buffer || !state) continue;
            
            if (!state.gainNode) {
                state.gainNode = this.audioContext.createGain();
                state.gainNode.gain.value = state.enabled ? state.volume : 0;
                state.gainNode.connect(this.masterGain);
            }
            
            const source = this.audioContext.createBufferSource();
            source.buffer = buffer;
            source.connect(state.gainNode);
            source.start(now, offset);
            this.audioSources[`${stemName}_full`] = source;
        }
    }

    togglePlayPause() {
        if (!this.transport.isPlaying) {
            // Resume from paused position
            if (this.audioContext.state === 'suspended') {
                this.audioContext.resume();
            }
            
            const now = this.audioContext.currentTime + 0.05;
            this.transport.startTime = now - this.transport.pausedAt;
            this.transport.isPlaying = true;
            this.updatePlayPauseUI();
            this.startTransportTicker();
            
            // Prefer continuous resume if full stems are available to avoid desync
            if (this.scheduler.continuousLoaded) {
                this.scheduler.usingChunks = false;
                for (const source of Object.values(this.audioSources)) {
                    try { source.stop(); } catch (_) {}
                }
                this.audioSources = {};
                this.startContinuousPlayback(this.transport.pausedAt);
            } else if (this.scheduler.usingChunks) {
                const resumeChunkIndex = Math.floor(this.transport.pausedAt / this.scheduler.chunkDuration);
                const offsetInChunk = this.transport.pausedAt % this.scheduler.chunkDuration;
                this.scheduler.startTime = now - (resumeChunkIndex * this.scheduler.chunkDuration) - offsetInChunk;
                
                // Reschedule remaining chunks for each stem
                this.rescheduleChunksFromTime(this.transport.pausedAt);
                // Resume chunk scheduling for new chunks that might be ready
                this.resumeChunkScheduling();
            } else {
                // Resume continuous stems: stop any playing and restart from pausedAt to keep all stems aligned
                for (const source of Object.values(this.audioSources)) {
                    try { source.stop(); } catch (_) {}
                }
                this.audioSources = {};
                this.startContinuousPlayback(this.transport.pausedAt);
            }
            // Resume video
            this.syncMediaStart(now, this.transport.pausedAt);
        } else {
            // Pause: stop all scheduled sources and record pausedAt
            this.transport.pausedAt = this.getCurrentTime();
            this.transport.isPlaying = false;
            this.transport.tickerRunning = false; // Stop the progress ticker
            this.updatePlayPauseUI();
            if (this._pendingStartTimer) { try { clearTimeout(this._pendingStartTimer); } catch (_) {} this._pendingStartTimer = null; }
            
            // Stop all sources but keep transport state and scheduled tracking for resume
            for (const source of Object.values(this.audioSources)) {
                try {
                    source.stop();
                } catch (e) {
                    // Source might already be stopped
                }
            }
        if (this.pendingSources) this.pendingSources.clear();
            this.audioSources = {};
            // Note: Keep scheduled tracking intact for resume
            // Pause media video if present
            const video = document.querySelector('#mediaWrapper video');
            if (video) { try { video.pause(); } catch (_) {} }
        }
    }

    getCurrentTime() {
        if (!this.transport.isPlaying) return this.transport.pausedAt;
        return Math.max(0, this.audioContext.currentTime - this.transport.startTime);
    }

    startTransportTicker() {
        if (this.transport.tickerRunning) return; // Prevent multiple tickers
        
        this.transport.tickerRunning = true;
        const seekSlider = document.getElementById('seekSlider');
        const currentLabel = document.getElementById('currentTimeLabel');
        const tick = () => {
            if (!this.transport.tickerRunning || !this.transport.isPlaying) {
                this.transport.tickerRunning = false;
                return;
            }
            const t = this.getCurrentTime();
            // If we reached or passed the end, clamp and end playback
            if (this.transport.duration > 0 && t >= this.transport.duration - 0.02) {
                const clamped = this.transport.duration;
                currentLabel.textContent = this.formatTime(clamped);
                seekSlider.value = 100;
                // Final lyric/overlay update at end position
                try { this.updateLyricsAtTime(clamped); } catch (_) {}
                try { this.updateKaraokeOverlay(this.lyrics.activeIndex); } catch (_) {}
                this.onPlaybackEnded();
                return;
            } else {
                currentLabel.textContent = this.formatTime(t);
                if (this.transport.duration > 0) {
                    seekSlider.value = Math.min(100, (t / this.transport.duration) * 100);
                }
            }
            this.updateLyricsAtTime(t);
            // Keep media element in sync with audio clock
            this.syncMediaProgress();
            // Ensure karaoke overlay (including countdown timer) updates every frame
            try { this.updateKaraokeOverlay(this.lyrics.activeIndex); } catch (_) {}
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }

    onPlaybackEnded() {
        // Stop ticker and mark transport at end
        this.transport.isPlaying = false;
        this.transport.tickerRunning = false;
        this.transport.pausedAt = this.transport.duration;
        this.updatePlayPauseUI();
        // Stop any remaining sources
        for (const source of Object.values(this.audioSources)) {
            try { source.stop(); } catch (_) {}
        }
        this.audioSources = {};
        // Pause media element at end
        const video = document.querySelector('#mediaWrapper video');
        if (video) {
            try { video.pause(); } catch (_) {}
            try { video.currentTime = Math.max(0, this.transport.duration); } catch (_) {}
        }
    }

    updateDurationLabels() {
        document.getElementById('totalTimeLabel').textContent = this.formatTime(this.transport.duration);
    }

    formatTime(seconds) {
        if (!isFinite(seconds)) return '0:00';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60).toString().padStart(2, '0');
        return `${m}:${s}`;
    }

    updateSongDetails(meta) {
        const el = document.getElementById('songDetails');
        if (!el) return;
        const title = (meta && meta.title ? String(meta.title) : '').trim();
        const artist = (meta && meta.artist ? String(meta.artist) : '').trim();
        if (!title && !artist) {
            el.textContent = '';
            return;
        }
        el.textContent = artist ? `${artist} — ${title}` : title;
    }

    onSeekInput(e) {
        if (this.transport.duration <= 0) return;
        const ratio = e.target.value / 100;
        const newTime = ratio * this.transport.duration;
        document.getElementById('currentTimeLabel').textContent = this.formatTime(newTime);
        // If continuous stems are loaded, switch to continuous playback for accurate seeking
        if (this.scheduler.continuousLoaded) {
            // Stop any chunk sources
            for (const source of Object.values(this.audioSources)) {
                try { source.stop(); } catch (_) {}
            }
            this.audioSources = {};
            this.scheduler.usingChunks = false;
            this.transport.pausedAt = newTime;
            if (this.transport.isPlaying) {
                // Restart continuous playback at new time
                const now = this.audioContext.currentTime + 0.05;
                this.transport.startTime = now - newTime;
                this.startContinuousPlayback(newTime);
            }
        } else {
            // Fallback: seek by pausing/resuming chunk scheduler
            this.transport.pausedAt = newTime;
            if (this.transport.isPlaying) {
                // Pause then resume from new position
                this.transport.isPlaying = false;
                this.transport.tickerRunning = false;
                for (const source of Object.values(this.audioSources)) { try { source.stop(); } catch (_) {} }
                this.audioSources = {};
                const resumeChunkIndex = Math.floor(this.transport.pausedAt / this.scheduler.chunkDuration);
                const offsetInChunk = this.transport.pausedAt % this.scheduler.chunkDuration;
                const now = this.audioContext.currentTime + 0.05;
                this.transport.startTime = now - this.transport.pausedAt;
                this.transport.isPlaying = true;
                this.updatePlayPauseUI();
                this.startTransportTicker();
                this.scheduler.startTime = now - (resumeChunkIndex * this.scheduler.chunkDuration) - offsetInChunk;
                this.rescheduleChunksFromTime(this.transport.pausedAt);
                this.resumeChunkScheduling();
            }
        }
        // Sync media element currentTime
        const video = document.querySelector('#mediaWrapper video');
        if (video) {
            try { video.currentTime = newTime; } catch (_) {}
        }
    }

    updatePlayPauseUI() {
        const btn = document.getElementById('playPauseBtn');
        if (this.transport.isPlaying) {
            btn.textContent = 'Pause';
        } else {
            btn.textContent = 'Play';
        }
    }

    updateMasterAutoGain() {
        // Optional: scale master gain down as more stems are active
        const enabledCount = Object.values(this.trackStates).filter(s => s && s.enabled).length || 1;
        const base = 0.6;
        const scaled = base / Math.min(enabledCount, 4); // rough downmix compensation
        this.masterGain.gain.value = Math.max(0.35, scaled);
    }

    stopChunk(chunkIndex) {
        const { chunks } = this.currentSession;
        const chunk = chunks[chunkIndex];
        
        for (const [stemName, stemData] of Object.entries(chunk)) {
            const key = `${chunkIndex}_${stemName}`;
            const source = this.audioSources[key];
            
            if (source) {
                source.stop();
                delete this.audioSources[key];
            }
        }
    }

    playAll() {
        this.startPlaybackWhenReady();
    }

    stopAll() {
        // Stop all audio sources
        for (const source of Object.values(this.audioSources)) {
            try {
                source.stop();
            } catch (e) {
                // Source might already be stopped
            }
        }
        this.audioSources = {};
        if (this.pendingSources) this.pendingSources.clear();
        if (this._pendingStartTimer) { try { clearTimeout(this._pendingStartTimer); } catch (_) {} this._pendingStartTimer = null; }
        
        // Clear scheduled tracking for all stems
        for (const stemState of Object.values(this.scheduler.perStem)) {
            if (stemState.scheduled) {
                stemState.scheduled.clear();
            }
        }
        
        // Reset transport state
        this.transport.isPlaying = false;
        this.transport.pausedAt = 0;
        this.transport.startTime = 0;
        this.transport.tickerRunning = false; // Stop the progress ticker
        
        // Reset scheduler state
        this.scheduler.shouldAutoStart = false;
        
        // Update UI
        this.updatePlayPauseUI();
        const seekSlider = document.getElementById('seekSlider');
        const currentLabel = document.getElementById('currentTimeLabel');
        seekSlider.value = 0;
        currentLabel.textContent = '0:00';
    }

    reset() {
        this.stopAll();
        this.currentSession = null;
        this.audioBuffers = {};
        this.audioSources = {};
        this.trackStates = {};
        
        // Reset key offset
        this.keyOffset = 0;
        this.pitchRatio = 1.0;
        this.updateKeyOffsetDisplay();
        // Force worklet back to neutral
        if (this.pitchWorklet && this.pitchWorklet.parameters) {
            const param = this.pitchWorklet.parameters.get('pitch');
            if (param) param.setValueAtTime(1.0, this.audioContext.currentTime);
        }
        
        // Reset scheduler
        this.scheduler.perStem = {};
        this.scheduler.shouldAutoStart = true;
        this.scheduler.done = false;
        this.transport.duration = 0;
        
        // Reset UI
        document.getElementById('playerSection').style.display = 'none';
        document.getElementById('uploadSection').style.display = 'block';
        document.getElementById('fileInput').value = '';
        document.getElementById('seekSlider').disabled = true;
        this.updateSongDetails({ title: '', artist: '' });
        this.setRefineSearchEnabled(false);
    }

    showError(message) {
        document.getElementById('errorMessage').textContent = message;
        document.getElementById('errorModal').style.display = 'block';
    }

    setupTabs() {
        const tabs = document.querySelectorAll('.tab');
        const uploadSection = document.getElementById('uploadSection');
        const youtubeSection = document.getElementById('youtubeSection');
        tabs.forEach((btn) => {
            btn.addEventListener('click', () => {
                tabs.forEach((b) => b.classList.remove('active'));
                btn.classList.add('active');
                const target = btn.getAttribute('data-target');
                if (target === 'uploadSection') {
                    if (uploadSection) uploadSection.style.display = 'block';
                    if (youtubeSection) youtubeSection.style.display = 'none';
                } else if (target === 'youtubeSection') {
                    if (uploadSection) uploadSection.style.display = 'none';
                    if (youtubeSection) youtubeSection.style.display = 'block';
                }
            });
        });
    }

    setupYouTubeSearch() {
        const searchBtn = document.getElementById('youtubeSearchBtn');
        const searchInput = document.getElementById('youtubeSearchInput');
        const tabsContainer = document.getElementById('youtubeResultsTabs');
        const placeholder = document.getElementById('youtubeResultsPlaceholder');
        const songsPanel = document.getElementById('youtubeSongsResults');
        const videosPanel = document.getElementById('youtubeVideosResults');
        const tabs = Array.from(document.querySelectorAll('.yt-results-tab'));
        if (!searchBtn || !searchInput || !tabsContainer || !placeholder || !songsPanel || !videosPanel) return;

        const tabMap = {};
        tabs.forEach((tab) => {
            const target = tab.getAttribute('data-target');
            if (target) tabMap[target] = tab;
        });

        const activateTab = (panelId) => {
            if (!panelId) return;
            tabs.forEach((tab) => {
                const target = tab.getAttribute('data-target');
                const isActive = target === panelId;
                tab.classList.toggle('active', isActive);
            });
            [songsPanel, videosPanel].forEach((panel) => {
                if (!panel) return;
                const isActive = panel.id === panelId;
                panel.classList.toggle('active', isActive);
                if (isActive) panel.removeAttribute('hidden'); else panel.setAttribute('hidden', '');
            });
        };

        tabs.forEach((tab) => {
            tab.addEventListener('click', () => {
                if (tab.disabled) return;
                const target = tab.getAttribute('data-target');
                activateTab(target);
            });
        });

        const resetPanels = () => {
            [songsPanel, videosPanel].forEach((panel) => {
                if (!panel) return;
                panel.innerHTML = '';
                panel.classList.remove('active');
                panel.setAttribute('hidden', '');
            });
        };

        const showPlaceholder = (html) => {
            resetPanels();
            tabs.forEach((tab) => tab.classList.remove('active'));
            placeholder.innerHTML = html;
            placeholder.style.display = 'block';
            tabsContainer.style.display = 'none';
        };

        const showTabs = () => {
            placeholder.style.display = 'none';
            tabsContainer.style.display = 'flex';
        };

        this.youtubeUI = {
            tabsContainer,
            placeholder,
            songsPanel,
            videosPanel,
            tabs,
            tabMap,
            activateTab,
            showPlaceholder,
            showTabs,
            resetPanels,
        };

        const triggerSearch = async () => {
            const query = (searchInput.value || '').trim();
            if (!this.youtubeUI) return;
            if (query.length === 0) {
                this.youtubeUI.showPlaceholder('<i class="fas fa-info-circle"></i> Enter a query to search YouTube.');
                return;
            }
            // If the query looks like a YouTube URL or raw ID, start that video directly
            const directId = this.parseYouTubeVideoId(query);
            if (directId) {
                this.youtubeUI.showPlaceholder('<i class="fas fa-spinner fa-spin"></i> Loading video...');
                try {
                    const hasActiveSession = !!this.currentSession || this.transport.isPlaying || Object.keys(this.audioSources || {}).length > 0;
                    if (hasActiveSession) {
                        const ok = window.confirm('A song is currently loaded. Replace it with the new selection?');
                        if (!ok) {
                            this.youtubeUI.showPlaceholder('<i class="fas fa-info-circle"></i> Enter a query to search YouTube.');
                            return;
                        }
                        this.stopAll();
                        if (this.activeSessionId) {
                            try { await fetch(`/api/cleanup/${encodeURIComponent(this.activeSessionId)}`, { method: 'POST' }); } catch (_) {}
                        }
                        this.currentSession = null;
                        this.audioBuffers = {};
                        this.audioSources = {};
                        this.trackStates = {};
                        this.keyOffset = 0;
                        this.pitchRatio = 1.0;
                        this.updateKeyOffsetDisplay();
                        this.scheduler.perStem = {};
                        this.scheduler.shouldAutoStart = true;
                        this.scheduler.done = false;
                        this.scheduler.continuousLoaded = false;
                        this.scheduler.usingChunks = true;
                        this.transport.duration = 0;
                        const stemsContainer = document.getElementById('stemsContainer');
                        if (stemsContainer) stemsContainer.innerHTML = '';
                        const seekSlider = document.getElementById('seekSlider');
                        const currentLabel = document.getElementById('currentTimeLabel');
                        const totalLabel = document.getElementById('totalTimeLabel');
                        if (seekSlider) { seekSlider.value = 0; seekSlider.disabled = true; }
                        if (currentLabel) currentLabel.textContent = '0:00';
                        if (totalLabel) totalLabel.textContent = '0:00';
                    }
                    let meta = { title: '', artist: '' };
                    try { meta = await this.fetchVideoMetadata(directId); } catch (_) {}
                    await this.startYouTubeSession(directId, { title: meta.title || '', artist: meta.artist || '', type: 'video', thumbnail: '' });
                } finally {
                    this.youtubeUI.showPlaceholder('<i class="fas fa-info-circle"></i> Enter a query to search YouTube.');
                }
                return;
            }
            // Otherwise perform a text search
            this.youtubeUI.showPlaceholder('<i class="fas fa-spinner fa-spin"></i> Searching for "' + this.escapeHtml(query) + '"...');
            this.fetchYouTubeResults(query);
        };

        searchBtn.addEventListener('click', (e) => {
            e.preventDefault();
            triggerSearch();
        });
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                triggerSearch();
            }
        });
    }

    async fetchYouTubeResults(query) {
        const ui = this.youtubeUI || {};
        const { songsPanel, videosPanel, tabsContainer, placeholder, activateTab, tabMap } = ui;
        try {
            const res = await fetch(`/api/yt/search?q=${encodeURIComponent(query)}`);
            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || 'Search failed');
            }
            const songs = Array.isArray(data.songs) ? data.songs.slice(0, 10) : [];
            const videos = Array.isArray(data.videos) ? data.videos.slice(0, 10) : [];
            if (songsPanel) this.renderYouTubeResults(songs, songsPanel, '<i class="fas fa-circle-info"></i> No songs found.');
            if (videosPanel) this.renderYouTubeResults(videos, videosPanel, '<i class="fas fa-circle-info"></i> No videos found.');

            const hasSongs = songs.length > 0;
            const hasVideos = videos.length > 0;

            if (tabsContainer && placeholder) {
                if (hasSongs || hasVideos) {
                    if (ui.showTabs) ui.showTabs(); else {
                        placeholder.style.display = 'none';
                        tabsContainer.style.display = 'flex';
                    }
                    const songsTab = tabMap ? tabMap['youtubeSongsResults'] : null;
                    const videosTab = tabMap ? tabMap['youtubeVideosResults'] : null;
                    if (songsTab) songsTab.disabled = !hasSongs;
                    if (videosTab) videosTab.disabled = !hasVideos;
                    const preferredPanel = hasSongs ? 'youtubeSongsResults' : 'youtubeVideosResults';
                    if (activateTab) activateTab(preferredPanel);
                } else {
                    tabsContainer.style.display = 'none';
                    placeholder.innerHTML = '<i class="fas fa-circle-info"></i> No results found.';
                    placeholder.style.display = 'block';
                }
            }
        } catch (err) {
            if (songsPanel) songsPanel.innerHTML = '';
            if (videosPanel) videosPanel.innerHTML = '';
            if (tabsContainer) tabsContainer.style.display = 'none';
            if (placeholder) {
                placeholder.innerHTML = `<i class="fas fa-triangle-exclamation"></i> ${this.escapeHtml(err.message)}`;
                placeholder.style.display = 'block';
            }
        }
    }

    renderYouTubeResults(items, container, emptyMessage = '<i class="fas fa-circle-info"></i> No results found.') {
        if (!container) return;
        container.innerHTML = '';
        if (!items.length) {
            const empty = document.createElement('div');
            empty.className = 'placeholder';
            empty.innerHTML = emptyMessage;
            container.appendChild(empty);
            return;
        }
        const grid = document.createElement('div');
        grid.className = 'yt-results-grid';
        items.slice(0, 10).forEach((item) => {
            const card = document.createElement('div');
            card.className = 'yt-card';
            const thumbUrl = item.thumbnails || '';
            const title = item.title || 'Untitled';
            const duration = item.duration || '';
            const authors = this.formatAuthors(item.author);
            const views = item.views || '';
            const subText = [authors, duration, views ? `${views} views` : '']
                .filter(Boolean)
                .join(' · ');
            card.setAttribute('data-video-id', item.videoId || '');
            card.setAttribute('data-type', item.type || '');
            card.addEventListener('click', async () => {
                const vid = item.videoId;
                if (!vid) return;
                // Visual feedback
                card.style.opacity = '0.7';
                try {
                    // If a session is active (playing or loaded), confirm replacement
                    const hasActiveSession = !!this.currentSession || this.transport.isPlaying || Object.keys(this.audioSources || {}).length > 0;
                    if (hasActiveSession) {
                        const ok = window.confirm('A song is currently loaded. Replace it with the new selection?');
                        if (!ok) return;
                        // Cleanly stop current playback and prepare for a new session without toggling tabs
                        this.stopAll();
                        // Attempt backend cleanup of the previous session to avoid stale files
                        if (this.activeSessionId) {
                            try { await fetch(`/api/cleanup/${encodeURIComponent(this.activeSessionId)}`, { method: 'POST' }); } catch (_) {}
                        }
                        this.currentSession = null;
                        this.audioBuffers = {};
                        this.audioSources = {};
                        this.trackStates = {};
                        // Reset key offset
                        this.keyOffset = 0;
                        this.pitchRatio = 1.0;
                        this.updateKeyOffsetDisplay();
                        this.scheduler.perStem = {};
                        this.scheduler.shouldAutoStart = true;
                        this.scheduler.done = false;
                        this.scheduler.continuousLoaded = false;
                        this.scheduler.usingChunks = true;
                        this.transport.duration = 0;
                        // Clear stems UI immediately for visual reset
                        const stemsContainer = document.getElementById('stemsContainer');
                        if (stemsContainer) stemsContainer.innerHTML = '';
                        // Reset UI pieces
                        const seekSlider = document.getElementById('seekSlider');
                        const currentLabel = document.getElementById('currentTimeLabel');
                        const totalLabel = document.getElementById('totalTimeLabel');
                        if (seekSlider) { seekSlider.value = 0; seekSlider.disabled = true; }
                        if (currentLabel) currentLabel.textContent = '0:00';
                        if (totalLabel) totalLabel.textContent = '0:00';
                        // Reset lyrics to loading placeholder only when we actually start a new session fetch below
                    }
                    const titleMeta = item.title || '';
                    let artistMeta = '';
                    if (Array.isArray(item.author) && item.author.length > 0) {
                        artistMeta = item.author[0]?.name || '';
                    } else if (typeof item.author === 'object' && item.author) {
                        artistMeta = item.author.name || '';
                    } else if (typeof item.author === 'string') {
                        artistMeta = item.author;
                    }
                    await this.startYouTubeSession(vid, { title: titleMeta, artist: artistMeta, type: item.type || '', thumbnail: item.thumbnails || '' });
                } finally {
                    card.style.opacity = '';
                }
            });
            const hasThumb = !!(thumbUrl && thumbUrl.trim());
            const thumbMarkup = hasThumb
                ? `<img src="${this.escapeAttribute(thumbUrl)}" alt="${this.escapeAttribute(title)}" loading="lazy"/>`
                : `<span class="thumb-icon"><i class="fas fa-music"></i></span>`;
            card.innerHTML = `
                <div class="thumb${hasThumb ? '' : ' missing'}">
                    ${thumbMarkup}
                </div>
                <div class="meta">
                    <div class=\"title\" title=\"${this.escapeAttribute(title)}\">${this.escapeHtml(title)}</div>
                    <div class=\"sub\">${this.escapeHtml(subText)}</div>
                </div>
            `;
            grid.appendChild(card);
        });
        container.appendChild(grid);
    }

    async startYouTubeSession(videoId, metadata) {
        // Show processing UI similar to file upload flow
        this.showProcessingProgress();
        this.scrollPlayerIntoView();
        try {
            const res = await fetch(`/api/yt/start/${encodeURIComponent(videoId)}`, { method: 'POST' });
            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || 'Failed to start YouTube session');
            }
            this.currentSession = data;
            this.activeSessionId = data.session_id;
            // Reset lyrics offset for a new session
            this.resetLyricsOffset();
            // Persist latest metadata for refine form
            this._latestTitle = (metadata && metadata.title) || '';
            this._latestArtist = (metadata && metadata.artist) || '';
            // Begin processing progress and player setup
            this.createStemsPlayer();
            this.scheduler.chunkDuration = this.currentSession.chunk_duration || 5.0;
            this.scheduler.shouldAutoStart = true;
            this.startPolling();
            this.showPlayerActiveUI();
            this.scrollPlayerIntoView();
            // Render media (video or cover) using returned source URLs and provided metadata
            this.renderMediaPane({
                videoUrl: (data.source && data.source.video_url) || '',
                audioUrl: (data.source && data.source.audio_url) || '',
                type: (metadata && metadata.type) || '',
                thumbnail: (metadata && metadata.thumbnail) || ''
            });
            // Do NOT autoplay media immediately; wait for first audio chunk auto-start to sync
            // Kick off lyrics fetch with available metadata
            if (metadata && (metadata.title || metadata.artist)) {
                this.loadLyricsForCurrentTrack({
                    title: metadata.title || '',
                    artist: metadata.artist || ''
                });
                this.updateSongDetails({ title: metadata.title || '', artist: metadata.artist || '' });
            } else {
                // Clear lyrics if none
                this.parseAndSetLyrics('');
                this.updateSongDetails({ title: '', artist: '' });
            }
        } catch (e) {
            this.showError(e.message);
        }
    }

    renderMediaPane({ videoUrl = '', audioUrl = '', type = '', thumbnail = '' }) {
        const wrapper = document.getElementById('mediaWrapper');
        const pane = document.getElementById('mediaPane');
        if (!wrapper || !pane) return;
        wrapper.innerHTML = '';
        const hasVideo = !!videoUrl;
        const hasImage = !!thumbnail;
        if (!hasVideo && !hasImage) {
            pane.style.display = 'none';
            this.schedulePlayerWidthUpdate();
            return;
        }
        pane.style.display = '';
        if (hasVideo) {
            const video = document.createElement('video');
            video.setAttribute('playsinline', '');
            video.setAttribute('webkit-playsinline', '');
            video.setAttribute('autoplay', '');
            if (thumbnail) video.setAttribute('poster', thumbnail);
            video.muted = true; // allow autoplay without user gesture
            video.controls = false; // not standalone controls
            video.preload = 'auto';
            // Stabilize playback rate defaults
            try { video.defaultPlaybackRate = 1.0; } catch (_) {}
            try { video.playbackRate = 1.0; } catch (_) {}
            // Avoid pitch correction when rate is tweaked
            try { video.preservesPitch = false; video.mozPreservesPitch = false; video.webkitPreservesPitch = false; } catch (_) {}
            video.src = videoUrl;
            wrapper.appendChild(video);
            // Inject karaoke overlay
            this.ensureKaraokeOverlay(wrapper);
            // Disable backdrop blur on videos to avoid GPU bugs in some browsers
            const overlay = wrapper.querySelector('.karaoke-overlay');
            if (overlay) overlay.classList.add('no-blur');
            const finalize = () => this.schedulePlayerWidthUpdate();
            video.addEventListener('loadedmetadata', finalize, { once: true });
            video.addEventListener('loadeddata', finalize, { once: true });
            if (video.readyState >= 1) finalize();
        } else if (hasImage) {
            const img = document.createElement('img');
            img.alt = 'Cover image';
            img.src = thumbnail;
            wrapper.appendChild(img);
            // Inject karaoke overlay on image as well
            this.ensureKaraokeOverlay(wrapper);
            const overlay = wrapper.querySelector('.karaoke-overlay');
            if (overlay) overlay.classList.remove('no-blur');
            if (img.complete) {
                this.schedulePlayerWidthUpdate();
            } else {
                img.addEventListener('load', () => this.schedulePlayerWidthUpdate(), { once: true });
                img.addEventListener('error', () => this.schedulePlayerWidthUpdate(), { once: true });
            }
        }
        this.schedulePlayerWidthUpdate();
    }

    schedulePlayerWidthUpdate() {
        if (this._playerWidthRaf) {
            cancelAnimationFrame(this._playerWidthRaf);
        }
        this._playerWidthRaf = requestAnimationFrame(() => {
            this._playerWidthRaf = null;
            this.updatePlayerWidthToMedia();
        });
    }

    updateKaraokeOverlaySizing(wrapperEl = null, metrics = null) {
        try {
            const wrapper = wrapperEl || document.getElementById('mediaWrapper');
            if (!wrapper) return;
            const overlay = wrapper.querySelector('.karaoke-overlay');
            if (!overlay) return;

            const width = overlay.clientWidth || wrapper.clientWidth || 0;
            const height = overlay.clientHeight || wrapper.clientHeight || 0;
            if (!width || !height) return;

            const overlayId = overlay.dataset.overlayInstanceId || '';
            const metricsObj = metrics && typeof metrics === 'object' ? metrics : {};
            const providedLeftHeight = Number.isFinite(metricsObj.leftHeight)
                ? Math.max(0, metricsObj.leftHeight)
                : null;
            const providedRightHeight = Number.isFinite(metricsObj.rightHeight)
                ? Math.max(0, metricsObj.rightHeight)
                : null;
            if (providedLeftHeight !== null) {
                overlay.dataset.lastLeftHeight = String(Math.round(providedLeftHeight));
            }
            if (providedRightHeight !== null) {
                overlay.dataset.lastRightHeight = String(Math.round(providedRightHeight));
            }
            const storedLeftHeight = Number.parseFloat(overlay.dataset.lastLeftHeight || '0');
            const storedRightHeight = Number.parseFloat(overlay.dataset.lastRightHeight || '0');
            const leftHeight = Number.isFinite(storedLeftHeight) ? storedLeftHeight : 0;
            const rightHeight = Number.isFinite(storedRightHeight) ? storedRightHeight : 0;

            const roundedWidth = Math.round(width);
            const roundedHeight = Math.round(height);
            const roundedLeft = Math.round(leftHeight || 0);
            const roundedRight = Math.round(rightHeight || 0);
            const cached = this.overlaySizeCache.get(wrapper);
            if (cached &&
                cached.width === roundedWidth &&
                cached.height === roundedHeight &&
                cached.overlayId === overlayId &&
                cached.left === roundedLeft &&
                cached.right === roundedRight) {
                return;
            }
            this.overlaySizeCache.set(wrapper, {
                width: roundedWidth,
                height: roundedHeight,
                overlayId,
                left: roundedLeft,
                right: roundedRight,
            });

            const minFont = 13;
            const maxFont = 48;
            const widthBased = width * 0.045;
            const heightBased = height * 0.11;
            const fontSize = Math.max(minFont, Math.min(maxFont, Math.min(widthBased, heightBased)));

            const lineHeight = fontSize * 1.18;
            const fallbackLeftHeight = lineHeight * 3.6;
            const fallbackRightHeight = lineHeight * 2.1;
            const effectiveLeftHeight = leftHeight > 0
                ? Math.max(leftHeight, lineHeight * 2.4)
                : fallbackLeftHeight;
            const effectiveRightHeight = rightHeight > 0
                ? Math.max(rightHeight, lineHeight * 1.6)
                : fallbackRightHeight;

            const timerFontSize = Math.max(11, Math.min(fontSize * 0.63, 24));

            const baseOffsetRaw = Math.max(fontSize * 0.4, height * 0.028);
            const clampedOffset = Math.min(baseOffsetRaw, height * 0.15);

            const leftOffset = Math.min(height * 0.24, clampedOffset + fontSize * 0.36);

            const gapReserve = Math.max(lineHeight * 0.4, fontSize * 0.45, 20);
            const requiredBandPx = effectiveLeftHeight + effectiveRightHeight + (clampedOffset * 2) + gapReserve;
            let bandFraction = requiredBandPx / height;
            bandFraction = Math.max(0.36, Math.min(bandFraction, 0.75));

            const gradientFraction = Math.min(0.92, Math.max(bandFraction + 0.1, 0.54));

            overlay.style.setProperty('--karaoke-line-font-size', `${fontSize.toFixed(2)}px`);
            overlay.style.setProperty('--karaoke-timer-font-size', `${timerFontSize.toFixed(2)}px`);
            overlay.style.setProperty('--karaoke-base-offset', `${clampedOffset.toFixed(2)}px`);
            overlay.style.setProperty('--karaoke-left-offset', `${leftOffset.toFixed(2)}px`);
            overlay.style.setProperty('--karaoke-lyrics-band-height', `${(bandFraction * 100).toFixed(2)}%`);
            overlay.style.setProperty('--karaoke-gradient-height', `${(gradientFraction * 100).toFixed(2)}%`);
        } catch (_) {
            /* sizing errors are non-fatal */
        }
    }

    updatePlayerWidthToMedia() {
        const section = document.getElementById('playerSection');
        const wrapper = document.getElementById('mediaWrapper');
        if (!section || !wrapper) return;
        section.style.width = '';
        section.style.width = '';
        this.updateKaraokeOverlaySizing(wrapper);
    }

    syncMediaStart(startAtAudioCtx, offsetSeconds) {
        const video = document.querySelector('#mediaWrapper video');
        if (!video) return;
        try {
            video.currentTime = Math.max(0, offsetSeconds || 0);
        } catch (_) {}
        // Try to play immediately; some browsers may still block, but muted helps
        const playAttempt = () => { try { const p = video.play(); if (p && typeof p.then === 'function') p.catch(() => {}); } catch (_) {} };
        // Only attempt to play when first chunk triggers audio start; this function is called from there
        if (video.readyState >= 2) {
            playAttempt();
        } else {
            video.addEventListener('loadeddata', () => playAttempt(), { once: true });
            video.addEventListener('canplay', () => playAttempt(), { once: true });
        }
    }

    // Nudge the <video> element to follow the WebAudio transport clock
    syncMediaProgress() {
        const video = document.querySelector('#mediaWrapper video');
        if (!video) return;
        // Ensure video keeps playing when audio plays
        if (this.transport.isPlaying && video.paused) {
            try { const p = video.play(); if (p && typeof p.then === 'function') p.catch(() => {}); } catch (_) {}
        }
        const target = Math.max(0, this.getCurrentTime());
        const current = Number.isFinite(video.currentTime) ? video.currentTime : 0;
        const drift = current - target;
        // Hard resync if far off
        const hardThreshold = 0.35;
        if (Math.abs(drift) > hardThreshold) {
            try { video.currentTime = target; } catch (_) {}
            try { video.playbackRate = 1.0; } catch (_) {}
            return;
        }
        // Soft correction with playbackRate
        const softThreshold = 0.06; // 60 ms
        let desiredRate = 1.0;
        if (drift > softThreshold) {
            // Video is ahead → slow it slightly
            desiredRate = 0.985;
        } else if (drift < -softThreshold) {
            // Video is behind → speed up slightly
            desiredRate = 1.015;
        }
        try {
            // Only adjust if different to avoid thrashing
            if (Math.abs((video.playbackRate || 1) - desiredRate) > 0.004) {
                video.playbackRate = desiredRate;
            }
        } catch (_) {}
    }

    async loadLyricsForCurrentTrack(metadata = null) {
        try {
            if (!metadata || !metadata.title || !metadata.artist) return;
            // Set loading state and render placeholder
            this.lyrics.loading = true;
            this.renderLyrics(-1);
            const qs = new URLSearchParams({ title: metadata.title, artist: metadata.artist });
            const res = await fetch(`/api/lyrics?${qs.toString()}`);
            const data = await res.json();
            if (!res.ok) {
                this.lyrics.loading = false;
                this.lyrics.entries = [];
                this.lyrics.activeIndex = -1;
                this.renderLyrics(-1);
                return;
            }
            if (data.lrc) {
                this.parseAndSetLyrics(data.lrc);
                // Reset overlay content on new lyrics
                this.updateKaraokeOverlay(-1);
            } else {
                this.lyrics.loading = false;
                this.lyrics.entries = [];
                this.lyrics.activeIndex = -1;
                this.renderLyrics(-1);
                this.updateKaraokeOverlay(-1);
            }
        } catch (e) {
            this.lyrics.loading = false;
            this.lyrics.entries = [];
            this.lyrics.activeIndex = -1;
            this.renderLyrics(-1);
            this.updateKaraokeOverlay(-1);
        }
    }

    parseAndSetLyrics(lrcText) {
        const lines = String(lrcText || '').split(/\r?\n/);
        const entries = [];
        for (const line of lines) {
            // Support [mm:ss.xx] and [mm:ss.xxx]
            const match = line.match(/\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]\s*(.*)/);
            if (!match) continue;
            const mm = parseInt(match[1], 10);
            const ss = parseInt(match[2], 10);
            const fracStr = match[3] || '';
            let fracSeconds = 0;
            if (fracStr.length === 3) {
                fracSeconds = parseInt(fracStr, 10) / 1000;
            } else if (fracStr.length === 2) {
                fracSeconds = parseInt(fracStr, 10) / 100;
            } else if (fracStr.length === 1) {
                fracSeconds = parseInt(fracStr, 10) / 10;
            }
            const time = mm * 60 + ss + fracSeconds;
            const rawText = match[4] || '';
            
            // Parse word-level lyrics if they exist (enhanced format)
            let text = rawText;
            let words = null;
            
            // Check if this line contains word-level timestamps: <mm:ss.xx> word <mm:ss.xx> word
            if (rawText.includes('<') && rawText.includes('>')) {
                const wordMatches = [];
                const wordPattern = /<(\d{2}):(\d{2})(?:\.(\d{1,3}))?>([^<]*?)(?=<|$)/g;
                let wordMatch;
                
                while ((wordMatch = wordPattern.exec(rawText)) !== null) {
                    const wordMm = parseInt(wordMatch[1], 10);
                    const wordSs = parseInt(wordMatch[2], 10);
                    const wordFracStr = wordMatch[3] || '';
                    let wordFracSeconds = 0;
                    if (wordFracStr.length === 3) {
                        wordFracSeconds = parseInt(wordFracStr, 10) / 1000;
                    } else if (wordFracStr.length === 2) {
                        wordFracSeconds = parseInt(wordFracStr, 10) / 100;
                    } else if (wordFracStr.length === 1) {
                        wordFracSeconds = parseInt(wordFracStr, 10) / 10;
                    }
                    const wordTime = wordMm * 60 + wordSs + wordFracSeconds;
                    const wordText = (wordMatch[4] || '').trim();
                    
                    if (wordText) {
                        wordMatches.push({ time: wordTime, text: wordText });
                    }
                }
                
                if (wordMatches.length > 0) {
                    words = wordMatches;
                    // Extract clean text by stripping inline timestamps, preserving punctuation/hyphens
                    text = rawText
                        .replace(/<(\d{2}):(\d{2})(?:\.(\d{1,3}))?>/g, '')
                        .replace(/\s+/g, ' ')
                        .trim();
                }
            }
            
            entries.push({ 
                time, 
                text,
                words: words, // Store word-level data for potential future use
                rawText: rawText // Keep original for debugging if needed
            });
        }
        entries.sort((a, b) => a.time - b.time);
        this.lyrics.entries = entries;
        this.lyrics.activeIndex = -1;
        this.lyrics.loading = false;
        this.lyrics.currentBlockStart = 0;
        this.lyrics._lastRenderedBlockStart = -1;
        this.lyrics._countdown.active = false; // Reset countdown state for new lyrics
        // After parsing, update word-level toggle availability
        this.updateWordLevelToggleUI();
        this.renderLyrics(-1);
        // Show first two lines immediately in overlay to indicate readiness
        this.updateKaraokeOverlay(-1);
    }

    updateLyricsAtTime(currentSeconds) {
        const entries = this.lyrics.entries;
        if (!entries || entries.length === 0) return;
        const adjusted = Math.max(0, currentSeconds + (this.lyrics.offset || 0));
        let low = 0, high = entries.length - 1, best = -1;
        while (low <= high) {
            const mid = (low + high) >> 1;
            if (entries[mid].time <= adjusted) {
                best = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        
        if (best !== this.lyrics.activeIndex) {
            this.lyrics.activeIndex = best;
            this.renderLyrics(best);
            this.updateKaraokeOverlay(best);
        }
        
        // Note: Word highlighting removed for plain text lyrics display
    }



    renderLyrics(activeIndex) {
        const container = this.lyricsContainer;
        if (!container) return;
        container.innerHTML = '';
        const entries = this.lyrics.entries;
        
        if (this.lyrics.loading) {
            const p = document.createElement('p');
            p.textContent = 'Loading lyrics...';
            container.appendChild(p);
            return;
        }
        
        if (!entries || entries.length === 0) {
            const p = document.createElement('p');
            p.textContent = 'No lyrics found.';
            container.appendChild(p);
            // Keep toggle UI in sync when no lyrics
            this.updateWordLevelToggleUI();
            return;
        }
        
        // Display all lyrics as plain text
        const lyricsDiv = document.createElement('div');
        lyricsDiv.className = 'plain-lyrics';
        
        // Extract and display only displayable lyrics (skip instrumental sections)
        const displayableEntries = entries.filter(entry => 
            entry && entry.text && this.isDisplayableLyricText(entry.text)
        );
        
        if (displayableEntries.length === 0) {
            const p = document.createElement('p');
            p.textContent = 'No lyrics available.';
            container.appendChild(p);
            return;
        }
        
        // Create plain text display
        displayableEntries.forEach((entry, index) => {
            const line = document.createElement('p');
            line.className = 'plain-lyric-line';
            line.textContent = entry.text;
            lyricsDiv.appendChild(line);
        });
        
        container.appendChild(lyricsDiv);
    }


    
    getCountdownInfo(activeIndex, currentTime, entries) {
        const findNext = (from) => this.findNextDisplayableIndex(from);
        
        // At start of song (no active lyric yet)
        if (activeIndex < 0) {
            const firstIdx = findNext(-1);
            if (firstIdx >= 0) {
                const firstLyricTime = entries[firstIdx].time;
                const timeToFirst = firstLyricTime - currentTime;
                
                // Show timer if more than 10 seconds until first lyric
                if (timeToFirst > 10) {
                    return { showTimer: true, secondsRemaining: timeToFirst };
                }
            }
            return { showTimer: false };
        }
        
        // Find current displayable lyric
        const currentIdx = this.findPrevDisplayableIndex(activeIndex);
        if (currentIdx >= 0) {
            const nextIdx = findNext(currentIdx);
            if (nextIdx >= 0) {
                const nextLyricTime = entries[nextIdx].time;
                const timeToNext = nextLyricTime - currentTime;
                
                // Show timer if more than 10 seconds until next lyric
                if (timeToNext > 10) {
                    return { showTimer: true, secondsRemaining: timeToNext };
                }
            }
        }
        
        return { showTimer: false };
    }
    
    formatCountdown(seconds) {
        if (seconds < 60) {
            return `${Math.max(0, Math.floor(seconds))}s`;
        } else {
            const mins = Math.floor(seconds / 60);
            const secs = Math.max(0, Math.floor(seconds % 60));
            return `${mins}:${secs.toString().padStart(2, '0')}`;
        }
    }

    ensureKaraokeOverlay(wrapperEl) {
        if (!wrapperEl) return;
        let overlay = wrapperEl.querySelector('.karaoke-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'karaoke-overlay';

            const timer = document.createElement('div');
            timer.className = 'karaoke-timer';
            timer.style.display = 'none';

            const left = document.createElement('div');
            left.className = 'karaoke-line karaoke-line-left';
            const right = document.createElement('div');
            right.className = 'karaoke-line karaoke-line-right';

            overlay.appendChild(timer);
            overlay.appendChild(left);
            overlay.appendChild(right);
            wrapperEl.appendChild(overlay);
        }
        if (!overlay.dataset.overlayInstanceId) {
            this.overlayInstanceCounter += 1;
            overlay.dataset.overlayInstanceId = `ov-${this.overlayInstanceCounter}`;
        }
        if (this.overlayResizeObserver) {
            try { this.overlayResizeObserver.observe(wrapperEl); } catch (_) {}
        }
        this.updateKaraokeOverlaySizing(wrapperEl);
    }

    updateKaraokeOverlay(activeIndex) {
        try {
            const wrapper = document.getElementById('mediaWrapper');
            if (!wrapper) return;
            let overlay = wrapper.querySelector('.karaoke-overlay');
            if (!overlay) {
                // Ensure overlay exists even if media was not yet interacted with
                this.ensureKaraokeOverlay(wrapper);
                overlay = wrapper.querySelector('.karaoke-overlay');
            }
            const timer = overlay.querySelector('.karaoke-timer');
            const left = overlay.querySelector('.karaoke-line-left');
            const right = overlay.querySelector('.karaoke-line-right');
            if (!left || !right || !timer) return;
            const entries = this.lyrics?.entries || [];
            
            if (!entries.length) {
                timer.style.display = 'none';
                left.textContent = '';
                right.textContent = '';
                left.classList.remove('current', 'next');
                right.classList.remove('current', 'next');
                return;
            }
            
            // Countdown timer logic: keep showing once started until reaching 0
            const currentTime = this.getCurrentTime();
            const adjustedTime = currentTime + (this.lyrics.offset || 0);

            // Determine upcoming lyric side and time
            const _findNext = (from) => this.findNextDisplayableIndex(from);
            const _findPrev = (from) => this.findPrevDisplayableIndex(from);
            const _countUpTo = (idx) => this.countDisplayablesUpTo(idx);
            let upcomingOnRight = true;
            let nextLyricTime = null;
            if (activeIndex >= 0) {
                const currentIdx = _findPrev(activeIndex);
                if (currentIdx >= 0) {
                    const seqIndex = _countUpTo(currentIdx) - 1;
                    upcomingOnRight = (seqIndex % 2) === 0;
                    const nextIdx = _findNext(currentIdx);
                    if (nextIdx >= 0) nextLyricTime = entries[nextIdx].time;
                } else {
                    // before first displayable
                    upcomingOnRight = false;
                    const firstIdx = _findNext(-1);
                    if (firstIdx >= 0) nextLyricTime = entries[firstIdx].time;
                }
            } else {
                // no active yet
                upcomingOnRight = false;
                const firstIdx = _findNext(-1);
                if (firstIdx >= 0) nextLyricTime = entries[firstIdx].time;
            }

            // Start countdown when gap > 10s
            if (!this.lyrics._countdown.active && typeof nextLyricTime === 'number') {
                const gap = nextLyricTime - adjustedTime;
                if (gap > 10) {
                    this.lyrics._countdown.active = true;
                    this.lyrics._countdown.targetTime = nextLyricTime;
                    this.lyrics._countdown.side = upcomingOnRight ? 'right' : 'left';
                }
            }

            // Handle countdown timer (but don't interfere with lyrics rendering)
            if (this.lyrics._countdown.active) {
                const secondsRemaining = Math.max(0, this.lyrics._countdown.targetTime - adjustedTime);
                if (secondsRemaining <= 0.01) { // Hide when lyric actually starts
                    this.lyrics._countdown.active = false;
                    timer.style.display = 'none';
                } else {
                    timer.style.display = 'block';
                    // Show actual countdown including 0s
                    const displayTime = Math.max(0, Math.ceil(secondsRemaining - 1));
                    timer.textContent = this.formatCountdown(displayTime);
                    // Position will be set after lyrics are rendered
                }
            } else {
                timer.style.display = 'none';
            }
            // Sliding window of two over displayable lines, positions alternate left/right
            left.classList.remove('current', 'next');
            right.classList.remove('current', 'next');
            const _findNext2 = (from) => this.findNextDisplayableIndex(from);
            const _findPrev2 = (from) => this.findPrevDisplayableIndex(from);
            const _countUpTo2 = (idx) => this.countDisplayablesUpTo(idx);
            if (activeIndex >= 0) {
                const currentIdx = _findPrev2(activeIndex);
                if (currentIdx >= 0) {
                    const nextIdx = _findNext2(currentIdx);
                    const seqIndex = _countUpTo2(currentIdx) - 1; // zero-based sequence index among displayables
                    const currentEntry = entries[currentIdx];
                    const previewEntry = nextIdx >= 0 ? entries[nextIdx] : null;
                    if ((seqIndex % 2) === 0) {
                        // Even sequence -> left current, right preview
                        this.renderKaraokeOverlayLine(left, currentEntry, 'current');
                        this.renderKaraokeOverlayLine(right, previewEntry, 'next');
                    } else {
                        // Odd sequence -> right current, left preview
                        this.renderKaraokeOverlayLine(right, currentEntry, 'current');
                        this.renderKaraokeOverlayLine(left, previewEntry, 'next');
                    }
                } else {
                    // No displayable yet, show first two as readiness preview
                    const firstIdx = _findNext2(-1);
                    const secondIdx = _findNext2(firstIdx);
                    const firstEntry = firstIdx >= 0 ? entries[firstIdx] : null;
                    const secondEntry = secondIdx >= 0 ? entries[secondIdx] : null;
                    this.renderKaraokeOverlayLine(left, firstEntry, 'next');
                    this.renderKaraokeOverlayLine(right, secondEntry, 'next');
                }
            } else {
                // Before first timestamp: show first two displayables as readiness preview
                const firstIdx = _findNext2(-1);
                const secondIdx = _findNext2(firstIdx);
                const firstEntry = firstIdx >= 0 ? entries[firstIdx] : null;
                const secondEntry = secondIdx >= 0 ? entries[secondIdx] : null;
                this.renderKaraokeOverlayLine(left, firstEntry, 'next');
                this.renderKaraokeOverlayLine(right, secondEntry, 'next');
            }
            
            // Update smooth word highlighting for karaoke overlay
            this.updateKaraokeWordHighlighting(adjustedTime);

            const leftHeight = left.offsetHeight || 0;
            const rightHeight = right.offsetHeight || 0;
            overlay.dataset.lastLeftHeight = String(Math.round(leftHeight));
            overlay.dataset.lastRightHeight = String(Math.round(rightHeight));
            this.updateKaraokeOverlaySizing(wrapper, { leftHeight, rightHeight });

            // Position countdown timer after lyrics are rendered
            if (this.lyrics._countdown.active && timer.style.display === 'block') {
                // Use a timeout to ensure DOM is updated
                setTimeout(() => {
                    try {
                        const targetEl = (this.lyrics._countdown.side === 'right') ? right : left;
                        if (targetEl.textContent) {
                            const overlayRect = overlay.getBoundingClientRect();
                            const targetRect = targetEl.getBoundingClientRect();
                            
                            // Position timer above right lyrics, below left lyrics
                            const timerY = this.lyrics._countdown.side === 'right' 
                                ? targetRect.top - overlayRect.top - 35  // 35px above for right side
                                : targetRect.bottom - overlayRect.top + 10; // 10px below for left side
                            
                            // Center horizontally with the lyric line
                            const centerX = targetRect.left - overlayRect.left + (targetRect.width / 2);
                            timer.style.left = `${centerX}px`;
                            timer.style.top = `${timerY}px`;
                            timer.style.transform = 'translateX(-50%)'; // Center the timer text
                        }
                    } catch (_) {}
                }, 0);
            }
        } catch (_) { /* non-fatal UI update error */ }
    }

    renderKaraokeOverlayLine(lineElement, entry, state) {
        if (!entry || !entry.text) {
            lineElement.textContent = '';
            lineElement.classList.remove('current', 'next');
            return;
        }

        // Clear previous content and classes
        lineElement.innerHTML = '';
        lineElement.classList.remove('current', 'next', 'no-words');
        lineElement.classList.add(state);

        const wordEnabled = !!(this.lyrics && this.lyrics.wordLevelEnabled);
        // If we have word-level timing data and feature is enabled, render individual words as spans
        if (wordEnabled && entry.words && entry.words.length > 0) {
            entry.words.forEach((word, index) => {
                const wordSpan = document.createElement('span');
                wordSpan.className = 'karaoke-word';
                wordSpan.dataset.wordTime = word.time;
                wordSpan.dataset.entryIndex = this.lyrics.entries.indexOf(entry);
                wordSpan.dataset.wordIndex = index;
                
                // Base layer (unfilled glyphs)
                const baseSpan = document.createElement('span');
                baseSpan.className = 'karaoke-word-base';
                baseSpan.textContent = word.text;

                const fillSpan = document.createElement('span');
                fillSpan.className = 'karaoke-word-fill';
                fillSpan.textContent = word.text;
                fillSpan.style.width = '0%';
                
                wordSpan.appendChild(baseSpan);
                wordSpan.appendChild(fillSpan);
                
                lineElement.appendChild(wordSpan);
                
                // Add space between words (except for the last word)
                if (index < entry.words.length - 1) {
                    lineElement.appendChild(document.createTextNode(' '));
                }
            });
        } else {
            // Mark line as lacking word-level timing so CSS can apply strong yellow
            lineElement.classList.add('no-words');
            // Fallback to regular text rendering for non-enhanced lyrics
            lineElement.textContent = entry.text;
        }
    }

    updateKaraokeWordHighlighting(currentTime) {
        // Skip if word-level highlighting is disabled
        if (!this.lyrics || !this.lyrics.wordLevelEnabled) return;
        // Find all karaoke words currently visible in the overlay
        const wordElements = document.querySelectorAll('.karaoke-word');
        
        wordElements.forEach(wordElement => {
            const wordTime = parseFloat(wordElement.dataset.wordTime);
            const entryIndex = parseInt(wordElement.dataset.entryIndex);
            const wordIndex = parseInt(wordElement.dataset.wordIndex);
            const fillElement = wordElement.querySelector('.karaoke-word-fill');
            
            if (!fillElement) return;
            
            // Remove previous highlighting classes
            wordElement.classList.remove('karaoke-word-active', 'karaoke-word-sung', 'karaoke-word-upcoming');
            
            const entry = this.lyrics.entries[entryIndex];
            if (!entry || !entry.words) return;
            
            const nextWordIndex = wordIndex + 1;
            // Determine end boundary for the current word:
            // 1) Next word in the same line, else
            // 2) Start of the next entry (line), else
            // 3) Small fallback window after the word start
            let nextWordTime;
            if (nextWordIndex < entry.words.length) {
                nextWordTime = entry.words[nextWordIndex].time;
            } else {
                const nextEntry = this.lyrics.entries[entryIndex + 1];
                nextWordTime = nextEntry && typeof nextEntry.time === 'number' 
                    ? nextEntry.time 
                    : wordTime + 0.6; // conservative default
            }
            
            if (currentTime < wordTime) {
                // Word is upcoming
                wordElement.classList.add('karaoke-word-upcoming');
                fillElement.style.width = '0%';
            } else if (currentTime >= nextWordTime) {
                // Word is completely sung
                wordElement.classList.add('karaoke-word-sung');
                fillElement.style.width = '100%';
            } else {
                // Word is currently being sung - calculate smooth fill progress
                wordElement.classList.add('karaoke-word-active');
                const wordDuration = nextWordTime - wordTime;
                const progress = wordDuration > 0 ? Math.min(1, (currentTime - wordTime) / wordDuration) : 1;
                const fillPercentage = Math.max(0, Math.min(100, progress * 100));
                // Always grow left->right regardless of overlay side
                fillElement.style.left = '0%';
                fillElement.style.right = '';
                fillElement.style.width = `${fillPercentage}%`;
            }
        });
    }

    // Helpers: treat only meaningful lyric lines as displayable
    isDisplayableLyricText(text) {
        const t = String(text || '').trim();
        if (t.length === 0) return false;
        const re = /^\s*(?:\(|\[)?\s*(instrumental|music|intro|outro|interlude|solo|bridge|break|riff|chorus|verse|pre-chorus|hook)\s*(?:\)|\])?\s*$/i;
        return !re.test(t);
    }

    findNextDisplayableIndex(fromIndex) {
        const entries = this.lyrics?.entries || [];
        for (let i = Math.max(-1, fromIndex) + 1; i < entries.length; i++) {
            if (this.isDisplayableLyricText(entries[i]?.text)) return i;
        }
        return -1;
    }

    findPrevDisplayableIndex(fromIndex) {
        const entries = this.lyrics?.entries || [];
        for (let i = Math.min(fromIndex, entries.length - 1); i >= 0; i--) {
            if (this.isDisplayableLyricText(entries[i]?.text)) return i;
        }
        return -1;
    }

    countDisplayablesUpTo(indexInclusive) {
        const entries = this.lyrics?.entries || [];
        const max = Math.min(indexInclusive, entries.length - 1);
        let count = 0;
        for (let i = 0; i <= max; i++) {
            if (this.isDisplayableLyricText(entries[i]?.text)) count++;
        }
        return count;
    }

    applyAdvancedVisibility(fromUserToggle = false) {
        const stemsContainer = document.getElementById('stemsContainer');
        if (!stemsContainer) return;
        const tracks = stemsContainer.querySelectorAll('.track');
        tracks.forEach((el) => {
            const name = (el.dataset.stemName || '').toLowerCase();
            const isVocal = name.includes('voc') || name.includes('vocal') || name === 'vocals' || name === 'sing' || name === 'vocal';
            if (this.isAdvanced) {
                el.classList.remove('hidden-simple');
            } else {
                if (!isVocal) el.classList.add('hidden-simple'); else el.classList.remove('hidden-simple');
            }
        });
        // Handle volume state persistence and reset behavior
        if (fromUserToggle) {
            if (this.isAdvanced) {
                // Capture current non-vocal volumes so we can restore when toggled off
                this.originalNonVocalVolumes = {};
                Object.keys(this.trackStates).forEach((stem) => {
                    const name = stem.toLowerCase();
                    const isVocal = name.includes('voc') || name.includes('vocal') || name === 'vocals' || name === 'sing' || name === 'vocal';
                    if (!isVocal) {
                        this.originalNonVocalVolumes[stem] = this.trackStates[stem]?.volume ?? 1.0;
                    }
                });
                // Ensure vocals are enabled by default in advanced mode
                Object.keys(this.trackStates).forEach((stem) => {
                    const name = (stem || '').toLowerCase();
                    const isVocal = name.includes('voc') || name.includes('vocal') || name === 'vocals' || name === 'sing' || name === 'vocal';
                    if (isVocal) {
                        const state = this.trackStates[stem];
                        if (state) {
                            state.enabled = true;
                            if (state.gainNode) state.gainNode.gain.value = state.volume;
                        }
                        const trackEl = document.getElementById(`stem-${stem}`) || Array.from(document.querySelectorAll('.track')).find(t => (t.dataset.stemName || '').toLowerCase() === name);
                        if (trackEl) {
                            const toggleSwitch = trackEl.querySelector('.track-toggle .toggle-switch');
                            const toggleLabel = trackEl.querySelector('.track-toggle span');
                            if (toggleSwitch) toggleSwitch.classList.add('active');
                            if (toggleLabel) toggleLabel.textContent = 'Enabled';
                        }
                    }
                });
            } else {
                // Reset non-vocals to 100%, re-enable them, and restore sliders/toggles
                const stems = Object.keys(this.trackStates || {});
                stems.forEach((stem) => {
                    const name = (stem || '').toLowerCase();
                    const isVocal = name.includes('voc') || name.includes('vocal') || name === 'vocals' || name === 'sing' || name === 'vocal';
                    if (!isVocal) {
                        // Set volume to 100% and enable
                        this.setStemVolume(stem, 1.0);
                        const state = this.trackStates[stem];
                        if (state) {
                            state.enabled = true;
                            if (state.gainNode) state.gainNode.gain.value = state.volume;
                        }
                        // Update UI if present
                        const trackEl = document.getElementById(`stem-${stem}`) || Array.from(document.querySelectorAll('.track')).find(t => (t.dataset.stemName || '').toLowerCase() === name);
                        if (trackEl) {
                            const slider = trackEl.querySelector('.volume-slider');
                            const label = trackEl.querySelector('.volume-label');
                            const toggleSwitch = trackEl.querySelector('.track-toggle .toggle-switch');
                            const toggleLabel = trackEl.querySelector('.track-toggle span');
                            if (slider) slider.value = '100';
                            if (label) label.textContent = '100%';
                            if (toggleSwitch) toggleSwitch.classList.add('active');
                            if (toggleLabel) toggleLabel.textContent = 'Enabled';
                        }
                    }
                });
                // Ensure vocals are disabled by default in simple mode
                stems.forEach((stem) => {
                    const name = (stem || '').toLowerCase();
                    const isVocal = name.includes('voc') || name.includes('vocal') || name === 'vocals' || name === 'sing' || name === 'vocal';
                    if (isVocal) {
                        const state = this.trackStates[stem];
                        if (state) {
                            state.enabled = false;
                            if (state.gainNode) state.gainNode.gain.value = 0;
                        }
                        const trackEl = document.getElementById(`stem-${stem}`) || Array.from(document.querySelectorAll('.track')).find(t => (t.dataset.stemName || '').toLowerCase() === name);
                        if (trackEl) {
                            const toggleSwitch = trackEl.querySelector('.track-toggle .toggle-switch');
                            const toggleLabel = trackEl.querySelector('.track-toggle span');
                            if (toggleSwitch) toggleSwitch.classList.remove('active');
                            if (toggleLabel) toggleLabel.textContent = 'Disabled';
                        }
                    }
                });
            }
        }
    }

    formatAuthors(authorField) {
        if (!authorField) return '';
        if (typeof authorField === 'string') return authorField;
        if (Array.isArray(authorField)) {
            return authorField.map((a) => (a && (a.name || a.artist || a.author || a.toString()))).filter(Boolean).join(', ');
        }
        if (typeof authorField === 'object') {
            return authorField.name || authorField.artist || authorField.author || '';
        }
        return '';
    }

    escapeAttribute(unsafe) {
        return String(unsafe)
            .replaceAll('&', '&amp;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;');
    }

    escapeHtml(unsafe) {
        return unsafe
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    setupRefineSearch() {
        const form = document.getElementById('refineSearchForm');
        const btn = document.getElementById('refineSearchBtn');
        const artistInput = document.getElementById('refineArtistInput');
        const titleInput = document.getElementById('refineTitleInput');
        if (!form || !btn || !artistInput || !titleInput) return;
        const handler = async (e) => {
            if (e) e.preventDefault();
            // Ignore if disabled
            if (btn.disabled || artistInput.disabled || titleInput.disabled) return;
            const artist = (artistInput.value || '').trim();
            const title = (titleInput.value || '').trim();
            if (!artist && !title) return;
            // Lyrics-only search; do not touch current audio session
            try {
                await this.loadLyricsForCurrentTrack({ title, artist });
            } catch (err) {
                this.showError(err.message || 'Lyrics search failed');
            }
        };
        form.addEventListener('submit', handler);
        btn.addEventListener('click', handler);
    }

    setRefineSearchEnabled(enabled) {
        const form = document.getElementById('refineSearchForm');
        const btn = document.getElementById('refineSearchBtn');
        const artistInput = document.getElementById('refineArtistInput');
        const titleInput = document.getElementById('refineTitleInput');
        const set = (el, on) => { if (el) el.disabled = !on; };
        set(btn, enabled);
        set(artistInput, enabled);
        set(titleInput, enabled);
        if (form) {
            if (enabled) form.classList.remove('disabled'); else form.classList.add('disabled');
        }
    }

    // Build a URL that goes through pitch endpoint when a key offset is active
    buildPitchedUrl(originalPath) {
        const semis = this.keyOffset || 0;
        if (Math.abs(semis) < 1e-6) {
            return originalPath;
        }
        try {
            const m = originalPath.match(/^\/api\/audio\/([^\/]+)\/(.+)$/);
            if (!m) return originalPath;
            const sessionId = m[1];
            const filename = m[2];
            const ts = Date.now();
            return `/api/pitch_audio/${encodeURIComponent(sessionId)}/${encodeURIComponent(filename)}?semitones=${encodeURIComponent(semis)}&ts=${encodeURIComponent(ts)}`;
        } catch (_) {
            return originalPath;
        }
    }
}

// Global functions for modal
function closeErrorModal() {
    document.getElementById('errorModal').style.display = 'none';
}

// Initialize app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new InstantKaraokeApp();
});
