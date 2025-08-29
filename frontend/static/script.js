class InstantKaraokeApp {
    constructor() {
        this.currentSession = null;
        this.audioContext = null;
        this.audioBuffers = {};
        this.audioSources = {};
        this.trackStates = {};
        this.transport = {
            isPlaying: false,
            startTime: 0,
            pausedAt: 0,
            duration: 0,
            tickerRunning: false,
        };
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
        
        this.initializeEventListeners();
        this.initializeAudioContext();
        this.initializeLyrics();
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
    }

    initializeLyrics() {
        this.lyrics = {
            entries: [],
            activeIndex: -1,
            loading: false,
            offset: 0.0,
        };
        this.lyricsContainer = document.getElementById('lyricsContainer');
    }

    initializeAudioContext() {
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            // Master chain: stems -> masterGain -> compressor -> softClipper -> destination
            this.masterGain = this.audioContext.createGain();
            this.masterGain.gain.value = 0.6; // more headroom
            this.compressor = this.audioContext.createDynamicsCompressor();
            this.compressor.threshold.value = -9; // stronger limiting
            this.compressor.knee.value = 12;
            this.compressor.ratio.value = 12;
            this.compressor.attack.value = 0.002;
            this.compressor.release.value = 0.2;
            this.softClipper = this.createSoftClipper(2.5);
            this.masterGain.connect(this.compressor);
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
            
            // Hide upload progress and show processing
            this.hideUploadProgress();
            this.showProcessingProgress();
            
            // Simulate processing progress (since backend doesn't provide real-time updates)
            this.simulateProcessingProgress();
            
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
        document.getElementById('processingSection').style.display = 'block';
    }

    hideProcessingProgress() {
        document.getElementById('processingSection').style.display = 'none';
    }

    simulateProcessingProgress() {
        const progressFill = document.getElementById('processingProgressFill');
        const progressText = document.getElementById('processingProgressText');
        const processingText = document.getElementById('processingText');
        
        let progress = 0;
        const steps = ['Loading model...', 'Separating tracks...', 'Processing chunks...', 'Finalizing...'];
        let stepIndex = 0;
        
        const interval = setInterval(() => {
            progress += Math.random() * 8;
            if (progress >= 100) {
                progress = 100;
                clearInterval(interval);
            }
            
            progressFill.style.width = progress + '%';
            progressText.textContent = `${Math.round(progress)}%`;
            
            if (progress > stepIndex * 25 && stepIndex < steps.length - 1) {
                stepIndex++;
                processingText.textContent = steps[stepIndex];
            }
        }, 300);
    }

    async loadStems() {
        const { session_id, stems } = this.currentSession;
        const stemNames = Object.keys(stems);
        
        // Start playback as soon as the first stem is decoded
        let firstStarted = false;
        
        stemNames.forEach(async (stemName, idx) => {
            const stemData = stems[stemName];
            const audioUrl = `/api/audio/${session_id}/${stemData.filename}`;
            try {
                const response = await fetch(audioUrl);
                const arrayBuffer = await response.arrayBuffer();
                const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
                this.audioBuffers[stemName] = audioBuffer;
                this.trackStates[stemName] = { enabled: true, volume: 1.0, gainNode: null };
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
                // For each ready chunk per stem, if first chunk just arrived, begin playback using that chunk
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
                    // Schedule new ready chunks in order for each stem (only if playing or should auto-start)
                    const state = this.scheduler.perStem[stemName] || { nextIndex: 0, scheduled: new Set() };
                    this.scheduler.perStem[stemName] = state;
                    while (ready.includes(state.nextIndex) && (this.transport.isPlaying || this.scheduler.shouldAutoStart)) {
                        // Only schedule if not already scheduled
                        if (!state.scheduled.has(state.nextIndex)) {
                            await this.scheduleChunk(sessionId, stemName, state.nextIndex);
                            state.scheduled.add(state.nextIndex);
                        }
                        state.nextIndex += 1;
                    }
                }
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
        const url = `/api/audio/${sessionId}/${stemName}.wav`;
        const res = await fetch(url);
        const buf = await res.arrayBuffer();
        const audioBuffer = await this.audioContext.decodeAudioData(buf);
        this.audioBuffers[stemName] = audioBuffer;
        this.trackStates[stemName] = this.trackStates[stemName] || { enabled: true, volume: 1.0, gainNode: null };
        this.transport.duration = Math.max(this.transport.duration, audioBuffer.duration);
        this.updateDurationLabels();
    }

    async scheduleChunk(sessionId, stemName, chunkIndex) {
        // Check if already scheduled to prevent duplicates
        const key = `${stemName}_${chunkIndex}`;
        if (this.audioSources[key]) {
            console.warn(`Chunk ${chunkIndex} for ${stemName} already scheduled`);
            return;
        }

        const url = `/api/audio/${sessionId}/chunk_${String(chunkIndex).padStart(3, '0')}_${stemName}.wav`;
        const res = await fetch(url);
        const buf = await res.arrayBuffer();
        const audioBuffer = await this.audioContext.decodeAudioData(buf);
        const state = this.trackStates[stemName] || { enabled: true, volume: 0.7, gainNode: null };
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
            this.updatePlayPauseUI();
            this.startTransportTicker();
            this.scheduler.startTime = now;
            this.scheduler.shouldAutoStart = false; // Prevent further auto-starts
        } else if (!this.transport.isPlaying) {
            // Don't schedule if transport is paused/stopped
            return;
        }
        const startAt = this.scheduler.startTime + (chunkIndex * this.scheduler.chunkDuration);
        source.start(startAt);
        // Track source so we can stop on pause/stop
        this.audioSources[key] = source;
        // Update duration based on highest scheduled chunk index
        this.transport.duration = Math.max(this.transport.duration, (chunkIndex + 1) * this.scheduler.chunkDuration);
        this.updateDurationLabels();
        this.updateMasterAutoGain();
    }

    async rescheduleChunksFromTime(resumeTime) {
        const sessionId = this.currentSession.session_id;
        const resumeChunkIndex = Math.floor(resumeTime / this.scheduler.chunkDuration);
        const offsetInChunk = resumeTime % this.scheduler.chunkDuration;
        
        // For each stem, reschedule chunks starting from resumeChunkIndex
        for (const [stemName, stemState] of Object.entries(this.scheduler.perStem)) {
            for (let chunkIndex = resumeChunkIndex; chunkIndex < stemState.nextIndex; chunkIndex++) {
                const key = `${stemName}_${chunkIndex}`;
                
                // Skip if already scheduled
                if (this.audioSources[key]) {
                    continue;
                }
                
                try {
                    const url = `/api/audio/${sessionId}/chunk_${String(chunkIndex).padStart(3, '0')}_${stemName}.wav`;
                    const res = await fetch(url);
                    const buf = await res.arrayBuffer();
                    const audioBuffer = await this.audioContext.decodeAudioData(buf);
                    
                    const state = this.trackStates[stemName];
                    if (!state || !state.gainNode) continue;
                    
                    const source = this.audioContext.createBufferSource();
                    source.buffer = audioBuffer;
                    source.connect(state.gainNode);
                    
                    // Start time for this chunk, accounting for resume offset
                    let startTime = this.scheduler.startTime + (chunkIndex * this.scheduler.chunkDuration);
                    let sourceOffset = 0;
                    
                    if (chunkIndex === resumeChunkIndex) {
                        // First chunk after resume - start with offset
                        sourceOffset = offsetInChunk;
                    }
                    
                    source.start(startTime, sourceOffset);
                    this.audioSources[key] = source;
                    stemState.scheduled.add(chunkIndex);
                } catch (e) {
                    console.warn(`Failed to reschedule chunk ${chunkIndex} for ${stemName}`);
                }
            }
        }
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
        this.hideProcessingProgress();
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
        toggleSwitch.className = 'toggle-switch active';
        toggleSwitch.onclick = (event) => this.toggleStem(event, stemName);
        
        const toggleLabel = document.createElement('span');
        toggleLabel.textContent = 'Enabled';
        
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
        toggleSwitch.className = 'toggle-switch active';
        toggleSwitch.onclick = (event) => this.toggleTrack(event, chunkIndex, stemName);
        
        const toggleLabel = document.createElement('span');
        toggleLabel.textContent = 'Enabled';
        
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
        this.updatePlayPauseUI();
        this.startTransportTicker();
        this.startContinuousPlayback(0);
        this.showPlayerActiveUI();
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
            
            // If using chunk-based playback, restart scheduler
            if (this.scheduler.usingChunks) {
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
        } else {
            // Pause: stop all scheduled sources and record pausedAt
            this.transport.pausedAt = this.getCurrentTime();
            this.transport.isPlaying = false;
            this.transport.tickerRunning = false; // Stop the progress ticker
            this.updatePlayPauseUI();
            
            // Stop all sources but keep transport state and scheduled tracking for resume
            for (const source of Object.values(this.audioSources)) {
                try {
                    source.stop();
                } catch (e) {
                    // Source might already be stopped
                }
            }
            this.audioSources = {};
            // Note: Keep scheduled tracking intact for resume
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
            currentLabel.textContent = this.formatTime(t);
            if (this.transport.duration > 0) {
                seekSlider.value = Math.min(100, (t / this.transport.duration) * 100);
            }
            this.updateLyricsAtTime(t);
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
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
                this.togglePlayPause();
                this.togglePlayPause();
            }
        }
    }

    updatePlayPauseUI() {
        const btn = document.getElementById('playPauseBtn');
        if (this.transport.isPlaying) {
            btn.innerHTML = '<i class="fas fa-pause"></i> Pause';
        } else {
            btn.innerHTML = '<i class="fas fa-play"></i> Play';
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
        const results = document.getElementById('youtubeResults');
        if (!searchBtn || !searchInput || !results) return;

        const triggerSearch = () => {
            const query = (searchInput.value || '').trim();
            results.innerHTML = '';
            const placeholder = document.createElement('div');
            placeholder.className = 'placeholder';
            if (query.length === 0) {
                placeholder.innerHTML = '<i class="fas fa-info-circle"></i> Enter a query to search YouTube.';
            } else {
                placeholder.innerHTML = `<i class=\"fas fa-spinner fa-spin\"></i> Searching for \"${this.escapeHtml(query)}\"...`;
                this.fetchYouTubeResults(query, results);
            }
            results.appendChild(placeholder);
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

    async fetchYouTubeResults(query, container) {
        try {
            const res = await fetch(`/api/yt/search?q=${encodeURIComponent(query)}`);
            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || 'Search failed');
            }
            this.renderYouTubeResults(data.results || [], container);
        } catch (err) {
            container.innerHTML = '';
            const error = document.createElement('div');
            error.className = 'placeholder';
            error.innerHTML = `<i class=\"fas fa-triangle-exclamation\"></i> ${this.escapeHtml(err.message)}`;
            container.appendChild(error);
        }
    }

    renderYouTubeResults(items, container) {
        container.innerHTML = '';
        if (!items.length) {
            const empty = document.createElement('div');
            empty.className = 'placeholder';
            empty.innerHTML = '<i class="fas fa-circle-info"></i> No results found.';
            container.appendChild(empty);
            return;
        }
        const grid = document.createElement('div');
        grid.className = 'yt-results-grid';
        items.slice(0, 24).forEach((item) => {
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
                    await this.startYouTubeSession(vid, { title: titleMeta, artist: artistMeta });
                } finally {
                    card.style.opacity = '';
                }
            });
            card.innerHTML = `
                <div class=\"thumb\">
                    <img src=\"${this.escapeAttribute(thumbUrl)}\" alt=\"${this.escapeAttribute(title)}\" loading=\"lazy\"/>
                </div>
                <div class=\"meta\">
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
        try {
            const res = await fetch(`/api/yt/start/${encodeURIComponent(videoId)}`, { method: 'POST' });
            const data = await res.json();
            if (!res.ok) {
                throw new Error(data.error || 'Failed to start YouTube session');
            }
            this.currentSession = data;
            this.activeSessionId = data.session_id;
            // Begin simulated processing progress and player setup
            this.simulateProcessingProgress();
            this.createStemsPlayer();
            this.scheduler.chunkDuration = this.currentSession.chunk_duration || 5.0;
            this.scheduler.shouldAutoStart = true;
            this.startPolling();
            this.showPlayerActiveUI();
            // Kick off lyrics fetch with available metadata
            if (metadata && (metadata.title || metadata.artist)) {
                this.loadLyricsForCurrentTrack({
                    title: metadata.title || '',
                    artist: metadata.artist || ''
                });
            } else {
                // Clear lyrics if none
                this.parseAndSetLyrics('');
            }
        } catch (e) {
            this.showError(e.message);
        }
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
            } else {
                this.lyrics.loading = false;
                this.lyrics.entries = [];
                this.lyrics.activeIndex = -1;
                this.renderLyrics(-1);
            }
        } catch (e) {
            this.lyrics.loading = false;
            this.lyrics.entries = [];
            this.lyrics.activeIndex = -1;
            this.renderLyrics(-1);
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
            const text = match[4] || '';
            entries.push({ time, text });
        }
        entries.sort((a, b) => a.time - b.time);
        this.lyrics.entries = entries;
        this.lyrics.activeIndex = -1;
        this.lyrics.loading = false;
        this.renderLyrics(-1);
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
        }
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
            return;
        }
        // Smooth scrolling: render more lines and scroll to current smoothly
        const viewportCount = 7;
        const start = Math.max(0, (activeIndex < 0 ? 0 : activeIndex) - Math.floor(viewportCount / 2));
        const end = Math.min(entries.length - 1, start + viewportCount - 1);
        for (let i = start; i <= end; i++) {
            const div = document.createElement('div');
            div.className = 'lyrics-line';
            div.textContent = entries[i].text || '';
            if (i < activeIndex) div.classList.add('prev');
            if (i === activeIndex) div.classList.add('current');
            if (i > activeIndex) div.classList.add('next');
            container.appendChild(div);
        }
        // Scroll current line into view smoothly
        const currentEl = container.querySelector('.lyrics-line.current');
        if (currentEl && typeof currentEl.scrollIntoView === 'function') {
            currentEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
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
}

// Global functions for modal
function closeErrorModal() {
    document.getElementById('errorModal').style.display = 'none';
}

// Initialize app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new InstantKaraokeApp();
});
