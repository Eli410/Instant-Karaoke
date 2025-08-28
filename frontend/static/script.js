class TrackFusionApp {
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
        this.scheduler = {
            usingChunks: true,
            startTime: 0,
            chunkDuration: 5.0,
            perStem: {}, // stemName -> { nextIndex: 0, scheduled: Set() }
            done: false,
            shouldAutoStart: true, // Allow auto-start only on first chunk
        };
        
        this.initializeEventListeners();
        this.initializeAudioContext();
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
        document.getElementById('resetBtn').addEventListener('click', () => this.reset());
        const seekSlider = document.getElementById('seekSlider');
        seekSlider.addEventListener('input', (e) => this.onSeekInput(e));
        seekSlider.disabled = true; // enable when continuous stems ready
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
        const poll = async () => {
            try {
                const res = await fetch(`/api/status/${sessionId}`);
                const status = await res.json();
                if (status.error) return;
                // For each ready chunk per stem, if first chunk just arrived, begin playback using that chunk
                for (const stemName of status.stems) {
                    const ready = status.ready[stemName] || [];
                    // Ensure stem UI exists
                    if (!document.getElementById(`stem-${stemName}`)) {
                        const el = this.createStemElement(stemName, {});
                        el.id = `stem-${stemName}`;
                        document.getElementById('stemsContainer').appendChild(el);
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
                    // Also switch to continuous playback when user seeks; keep chunk scheduler running until end
                }
                if (!status.done) {
                    setTimeout(poll, 1000);
                }
            } catch (e) {
                setTimeout(poll, 1500);
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
            // Start transport now at t=0 with this first scheduled chunk index 0
            const now = this.audioContext.currentTime + 0.05;
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
        
        const stemsContainer = document.getElementById('stemsContainer');
        stemsContainer.innerHTML = '';
        // stems will appear dynamically as they become ready
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
        const now = this.audioContext.currentTime + 0.05;
        this.transport.startTime = now;
        this.transport.isPlaying = true;
        this.transport.pausedAt = 0;
        this.updatePlayPauseUI();
        this.startTransportTicker();
        this.startContinuousPlayback(0);
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
                // Resume continuous stems
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
        // Seek support using chunk scheduler
        this.transport.pausedAt = newTime;
        if (this.transport.isPlaying) {
            // Pause then resume from new position
            this.togglePlayPause();
            this.togglePlayPause();
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
}

// Global functions for modal
function closeErrorModal() {
    document.getElementById('errorModal').style.display = 'none';
}

// Initialize app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new TrackFusionApp();
});
