// WSOLA-based pitch shifter with resampling for clean key changes
class PitchShifterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: 'pitch',
        defaultValue: 1.0,
        minValue: 0.5,
        maxValue: 2.0,
        automationRate: 'k-rate',
      },
    ];
  }

  nudgeReadBaseTowardLatencyTarget() {
    const targetBase = this.inputWriteIndex - this.latency;
    const drift = targetBase - this.readBase;
    if (Math.abs(drift) > this.hopIn) {
      this.readBase += Math.sign(drift) * this.hopIn;
    }
  }

  constructor() {
    super();
    
    // WSOLA parameters
    this.frameSize = 2048; // N
    this.hopIn = this.frameSize / 2; // 50% hop for perfect COLA
    this.bufferSize = this.frameSize * 8; // Large ring buffer
    this.latency = this.frameSize * 2; // Fixed read latency
    this.searchHalfWidth = this.hopIn / 2; // Search ±hopIn/2
    
    // Input ring buffers (per channel)
    this.inputBuffer = [new Float32Array(this.bufferSize), new Float32Array(this.bufferSize)];
    this.inputWriteIndex = 0;
    
    // WSOLA state
    this.readBase = 0;
    this.hopInAccum = 0;
    this.grainTimer = 0;
    this.prevGrainTail = [new Float32Array(0), new Float32Array(0)]; // Will be resized
    this.prevOffset = 0;
    
    // Stretched output buffers (intermediate)
    this.stretchedBufferSize = this.frameSize * 8;
    this.stretchedBuffer = [new Float32Array(this.stretchedBufferSize), new Float32Array(this.stretchedBufferSize)];
    this.stretchedWriteIndex = 0;
    this.stretchedReadIndex = 0;
    
    // OLA normalization buffer
    this.normBuffer = new Float32Array(this.stretchedBufferSize);
    
    // Resampler state
    this.resamplePhase = 0;
    
    // Window (equal-power crossfade: sqrt-Hann)
    this.window = new Float32Array(this.frameSize);
    for (let i = 0; i < this.frameSize; i++) {
      const hann = 0.5 * (1 - Math.cos(2 * Math.PI * i / this.frameSize));
      this.window[i] = Math.sqrt(hann);
    }
    
    // Initialize read position with latency offset
    this.readBase = this.latency;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    
    if (!input || !output || input.length === 0 || output.length === 0) {
      return true;
    }

    const frameCount = output[0].length;
    const channelCount = Math.min(input.length, output.length);
    const pitch = parameters.pitch[0] || 1.0;
    
    // Bypass when pitch is 1.0
    if (Math.abs(pitch - 1.0) < 0.001) {
      for (let ch = 0; ch < channelCount; ch++) {
        if (input[ch] && output[ch]) {
          output[ch].set(input[ch]);
        }
      }
      return true;
    }
    
    // Step 1: Ingest input into ring buffer
    this.ingestInput(input, channelCount, frameCount);
    
    // Step 2: WSOLA processing - generate stretched audio
    this.nudgeReadBaseTowardLatencyTarget();
    this.processWSOLA(channelCount, pitch, frameCount);
    
    // Step 3: Resample stretched audio to restore duration directly to output
    this.resampleToOutput(channelCount, pitch, frameCount, outputs);
    
    return true;
  }
  
  ingestInput(input, channelCount, frameCount) {
    // Write input samples to ring buffer
    for (let i = 0; i < frameCount; i++) {
      for (let ch = 0; ch < channelCount; ch++) {
        if (input[ch]) {
          const writeIdx = this.inputWriteIndex % this.bufferSize;
          this.inputBuffer[ch][writeIdx] = input[ch][i];
        }
      }
      this.inputWriteIndex++;
    }
  }

  processWSOLA(channelCount, pitch, frameCount) {
    const alpha = 1.0 / pitch; // Time-stretch factor
    const hopOut = Math.max(1, Math.min(this.frameSize - 1, Math.round(this.hopIn * alpha)));
    
    // Check if it's time to emit a new grain
    if (this.grainTimer <= 0) {
      // Calculate nominal read position
      const readNominal = this.readBase + this.hopInAccum;
      
      // Find best matching position using WSOLA similarity search
      const bestOffset = this.findBestMatch(readNominal, channelCount);
      const readActual = readNominal + bestOffset;
      
      // Extract and process grain
      this.extractAndProcessGrain(readActual, hopOut, channelCount);
      
      // Update timing
      this.hopInAccum += this.hopIn;
      this.grainTimer += hopOut; // accumulate in sample domain
      
      // Keep read base bounded relative to write head
      const writeHead = this.inputWriteIndex;
      const maxLag = this.bufferSize - this.frameSize * 2;
      if (writeHead - this.readBase > maxLag) {
        this.readBase = writeHead - this.latency;
        this.hopInAccum = 0;
      }
    }
    this.grainTimer -= frameCount; // decrement by processed samples
  }

  findBestMatch(readNominal, channelCount) {
    if (this.prevGrainTail[0].length === 0) {
      return 0; // First grain, no previous tail to match
    }
    
    const overlapLen = this.prevGrainTail[0].length;
    let bestOffset = 0;
    let bestScore = -Infinity;
    
    // Search within a biased window around previous offset to reduce hopping
    const S = this.searchHalfWidth | 0;
    const half = (S >> 1) || 1;
    const center = Math.max(-S, Math.min(S, this.prevOffset | 0));
    const searchStart = center - half;
    const searchEnd = center + half;
    
    for (let offset = searchStart; offset <= searchEnd; offset += 4) { // Step by 4 for performance
      let score = 0;
      let norm1 = 0;
      let norm2 = 0;
      
      // Compute normalized cross-correlation (sum over channels for mono search)
      for (let ch = 0; ch < channelCount; ch++) {
        for (let i = 0; i < overlapLen; i++) {
          const readPos = readNominal + offset - overlapLen + i;
          const sample = this.readInputSample(ch, readPos);
          const prevSample = this.prevGrainTail[ch][i];
          
          score += sample * prevSample;
          norm1 += sample * sample;
          norm2 += prevSample * prevSample;
        }
      }
      
      // Normalized correlation
      const normalizedScore = (norm1 > 0 && norm2 > 0) ? score / Math.sqrt(norm1 * norm2) : 0;
      
      if (normalizedScore > bestScore) {
        bestScore = normalizedScore;
        bestOffset = offset;
      }
    }
    
    // Apply light hysteresis to avoid bouncing between near-best offsets
    const smooth = 0.25; // 0..1, smaller = steadier
    const proposed = this.prevOffset + smooth * (bestOffset - this.prevOffset);
    const snapped = Math.round(proposed); // integer sample offset
    this.prevOffset = Math.max(-S, Math.min(S, snapped));
    return this.prevOffset;
  }

  extractAndProcessGrain(readPos, hopOut, channelCount) {
    const overlapLen = this.frameSize - hopOut;
    
    // Extract grain and apply window
    const grain = [];
    for (let ch = 0; ch < channelCount; ch++) {
      grain[ch] = new Float32Array(this.frameSize);
      for (let i = 0; i < this.frameSize; i++) {
        const sample = this.readInputSample(ch, readPos - this.frameSize + i);
        grain[ch][i] = sample * this.window[i];
      }
    }
    
    // Overlap-add into stretched buffer with equal-power normalization (sum of squares)
    for (let ch = 0; ch < channelCount; ch++) {
      for (let i = 0; i < this.frameSize; i++) {
        const writeIdx = (this.stretchedWriteIndex + i) % this.stretchedBufferSize;
        this.stretchedBuffer[ch][writeIdx] += grain[ch][i];
        
        // Accumulate window^2 weights for equal-power normalization (only once)
        if (ch === 0) {
          const w = this.window[i];
          this.normBuffer[writeIdx] += w * w;
        }
      }
    }
    
    // Update previous grain tail for next similarity search
    for (let ch = 0; ch < channelCount; ch++) {
      if (this.prevGrainTail[ch].length !== overlapLen) {
        this.prevGrainTail[ch] = new Float32Array(overlapLen);
      }
      for (let i = 0; i < overlapLen; i++) {
        this.prevGrainTail[ch][i] = grain[ch][this.frameSize - overlapLen + i];
      }
    }
    
    // Advance write position
    this.stretchedWriteIndex = (this.stretchedWriteIndex + hopOut) % this.stretchedBufferSize;
  }

  readInputSample(channel, position) {
    // Linear interpolation for fractional reads with safe modulo
    const pos = ((position % this.bufferSize) + this.bufferSize) % this.bufferSize;
    const idx0 = Math.floor(pos) % this.bufferSize;
    const idx1 = (idx0 + 1) % this.bufferSize;
    const frac = pos - Math.floor(pos);
    
    const sample0 = this.inputBuffer[channel][idx0];
    const sample1 = this.inputBuffer[channel][idx1];
    
    return sample0 + frac * (sample1 - sample0);
  }

  resampleToOutput(channelCount, pitch, frameCount, outputs) {
    const out = outputs[0];
    for (let i = 0; i < frameCount; i++) {
      const srcIndex = this.stretchedReadIndex + this.resamplePhase;
      const pos = ((srcIndex % this.stretchedBufferSize) + this.stretchedBufferSize) % this.stretchedBufferSize;
      const i0 = Math.floor(pos) % this.stretchedBufferSize;
      const i1 = (i0 + 1) % this.stretchedBufferSize;
      const frac = pos - Math.floor(pos);
      const norm = Math.max(1e-9, this.normBuffer[i0] * (1 - frac) + this.normBuffer[i1] * frac);
      
      for (let ch = 0; ch < channelCount; ch++) {
        const s0 = this.stretchedBuffer[ch][i0];
        const s1 = this.stretchedBuffer[ch][i1];
        const sample = s0 * (1 - frac) + s1 * frac;
        out[ch][i] = (sample / norm) * 0.7;
      }
      
      this.resamplePhase += pitch;
      if (this.resamplePhase >= 1.0) {
        const adv = Math.floor(this.resamplePhase);
        for (let step = 0; step < adv; step++) {
          const idx = (this.stretchedReadIndex + step) % this.stretchedBufferSize;
          for (let ch = 0; ch < channelCount; ch++) this.stretchedBuffer[ch][idx] = 0;
          this.normBuffer[idx] = 0;
        }
        this.stretchedReadIndex = (this.stretchedReadIndex + adv) % this.stretchedBufferSize;
        this.resamplePhase -= adv;
      }
    }
  }

  readStretchedSampleNoClear(channel, position) {
    // Linear interpolation for fractional reads from stretched buffer (no clearing)
    const pos = ((position % this.stretchedBufferSize) + this.stretchedBufferSize) % this.stretchedBufferSize;
    const idx0 = Math.floor(pos) % this.stretchedBufferSize;
    const idx1 = (idx0 + 1) % this.stretchedBufferSize;
    const frac = pos - Math.floor(pos);
    const sample0 = this.stretchedBuffer[channel][idx0];
    const sample1 = this.stretchedBuffer[channel][idx1];
    return sample0 + frac * (sample1 - sample0);
  }
}

registerProcessor('pitch-shifter-processor', PitchShifterProcessor);