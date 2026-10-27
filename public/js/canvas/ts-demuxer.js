/**
 * Minimal MPEG-TS demuxer for the canvas player.
 *
 * Handles exactly what /api/canvas/stream produces: one program with an H.264 video
 * stream (stream_type 0x1B) and an AAC/ADTS audio stream (stream_type 0x0F).
 *
 * Callbacks:
 *   onTracks({ video, audio })                     once the PMT is known (and on change)
 *   onVideo({ ptsUs, key, sps, data })             one Annex-B access unit per PES
 *   onAudio({ ptsUs, data, objectType, sampleRate, channels, audioSpecificConfig })
 *                                                  one raw AAC frame (ADTS header removed)
 */
'use strict';

const TS_PACKET = 188;
const SYNC_BYTE = 0x47;
const STREAM_TYPE_H264 = 0x1b;
const STREAM_TYPE_AAC_ADTS = 0x0f;
const PTS_WRAP = 2 ** 33;
const AAC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

class TsDemuxer {
    constructor({ onTracks = () => {}, onVideo = () => {}, onAudio = () => {} } = {}) {
        this.onTracks = onTracks;
        this.onVideo = onVideo;
        this.onAudio = onAudio;
        this.remainder = null;
        this.pmtPid = null;
        this.videoPid = null;
        this.audioPid = null;
        this.pes = new Map();          // pid -> { chunks, size, expected }
        this.pts = new Map();          // pid -> { last, wrap } for 33-bit unwrapping
        this.audioRemainder = null;    // partial ADTS frame spanning PES packets
    }

    push(chunk) {
        let data = chunk;
        if (this.remainder) {
            data = new Uint8Array(this.remainder.length + chunk.length);
            data.set(this.remainder, 0);
            data.set(chunk, this.remainder.length);
            this.remainder = null;
        }
        let offset = 0;
        while (offset + TS_PACKET <= data.length) {
            if (data[offset] !== SYNC_BYTE) {
                offset = this.resync(data, offset + 1);
                continue;
            }
            this.packet(data.subarray(offset, offset + TS_PACKET));
            offset += TS_PACKET;
        }
        if (offset < data.length) this.remainder = data.slice(offset);
    }

    /** End of stream: emit whatever PES data is still assembled. */
    flush() {
        for (const pid of this.pes.keys()) this.finishPes(pid);
    }

    resync(data, from) {
        for (let i = from; i < data.length; i++) {
            if (data[i] === SYNC_BYTE && (i + TS_PACKET >= data.length || data[i + TS_PACKET] === SYNC_BYTE)) return i;
        }
        return data.length;
    }

    packet(pkt) {
        const unitStart = (pkt[1] & 0x40) !== 0;
        const pid = ((pkt[1] & 0x1f) << 8) | pkt[2];
        const adaptation = (pkt[3] >> 4) & 0x03;
        if (!(adaptation & 0x01)) return; // no payload
        let offset = 4;
        if (adaptation & 0x02) offset += 1 + pkt[4];
        if (offset >= TS_PACKET) return;
        const payload = pkt.subarray(offset);

        if (pid === 0) return this.parsePat(payload, unitStart);
        if (pid === this.pmtPid) return this.parsePmt(payload, unitStart);
        if (pid !== this.videoPid && pid !== this.audioPid) return;

        if (unitStart) {
            this.finishPes(pid);
            const expected = payload.length >= 6 ? ((payload[4] << 8) | payload[5]) : 0;
            this.pes.set(pid, { chunks: [payload], size: payload.length, expected: expected ? expected + 6 : 0 });
        } else {
            const pes = this.pes.get(pid);
            if (!pes) return; // joined mid-packet; wait for the next unit start
            pes.chunks.push(payload);
            pes.size += payload.length;
        }
        const pes = this.pes.get(pid);
        if (pes.expected && pes.size >= pes.expected) this.finishPes(pid);
    }

    section(payload, unitStart) {
        if (!unitStart) return null; // PSI sections from ffmpeg fit in one packet
        const start = 1 + payload[0];
        const table = payload.subarray(start);
        if (table.length < 3) return null;
        const length = ((table[1] & 0x0f) << 8) | table[2];
        return table.subarray(0, Math.min(table.length, 3 + length));
    }

    parsePat(payload, unitStart) {
        const table = this.section(payload, unitStart);
        if (!table || table[0] !== 0x00) return;
        for (let i = 8; i + 4 <= table.length - 4; i += 4) {
            const program = (table[i] << 8) | table[i + 1];
            if (program !== 0) {
                this.pmtPid = ((table[i + 2] & 0x1f) << 8) | table[i + 3];
                return;
            }
        }
    }

    parsePmt(payload, unitStart) {
        const table = this.section(payload, unitStart);
        if (!table || table[0] !== 0x02) return;
        const programInfoLength = ((table[10] & 0x0f) << 8) | table[11];
        let video = null, audio = null;
        for (let i = 12 + programInfoLength; i + 5 <= table.length - 4;) {
            const type = table[i];
            const pid = ((table[i + 1] & 0x1f) << 8) | table[i + 2];
            const infoLength = ((table[i + 3] & 0x0f) << 8) | table[i + 4];
            if (type === STREAM_TYPE_H264 && video === null) video = pid;
            if (type === STREAM_TYPE_AAC_ADTS && audio === null) audio = pid;
            i += 5 + infoLength;
        }
        if (video === this.videoPid && audio === this.audioPid) return;
        this.videoPid = video;
        this.audioPid = audio;
        this.onTracks({ video: video !== null, audio: audio !== null });
    }

    finishPes(pid) {
        const pes = this.pes.get(pid);
        if (!pes) return;
        this.pes.delete(pid);
        const data = pes.chunks.length === 1 ? pes.chunks[0] : concat(pes.chunks, pes.size);
        if (data.length < 9 || data[0] !== 0 || data[1] !== 0 || data[2] !== 1) return;
        const flags = data[7];
        const headerLength = data[8];
        if (!(flags & 0x80) || data.length < 14) return; // every frame we emit carries a PTS
        const ptsUs = Math.round(this.unwrap(pid, readTimestamp(data, 9)) * 100 / 9);
        const end = pes.expected ? Math.min(pes.expected, data.length) : data.length;
        const payload = data.subarray(9 + headerLength, end);
        if (pid === this.videoPid) this.videoAccessUnit(payload, ptsUs);
        else this.audioFrames(payload, ptsUs);
    }

    unwrap(pid, pts) {
        let state = this.pts.get(pid);
        if (!state) this.pts.set(pid, state = { last: pts, wrap: 0 });
        let value = pts + state.wrap;
        if (value < state.last - PTS_WRAP / 2) { state.wrap += PTS_WRAP; value += PTS_WRAP; }
        state.last = value;
        return value;
    }

    videoAccessUnit(data, ptsUs) {
        let key = false, sps = null;
        for (const [start, end] of nalUnits(data)) {
            const type = data[start] & 0x1f;
            if (type === 5) key = true;
            else if (type === 7 && !sps) sps = data.slice(start, end);
        }
        this.onVideo({ ptsUs, key, sps, data });
    }

    audioFrames(payload, ptsUs) {
        let data = payload;
        let frameUs = ptsUs;
        if (this.audioRemainder) {
            data = concat([this.audioRemainder.data, payload], this.audioRemainder.data.length + payload.length);
            frameUs = this.audioRemainder.ptsUs;
            this.audioRemainder = null;
        }
        let offset = 0;
        while (offset + 7 <= data.length) {
            if (data[offset] !== 0xff || (data[offset + 1] & 0xf0) !== 0xf0) { offset++; continue; }
            const protectionAbsent = data[offset + 1] & 0x01;
            const objectType = ((data[offset + 2] >> 6) & 0x03) + 1;
            const sampleRateIndex = (data[offset + 2] >> 2) & 0x0f;
            const channels = ((data[offset + 2] & 0x01) << 2) | ((data[offset + 3] >> 6) & 0x03);
            const frameLength = ((data[offset + 3] & 0x03) << 11) | (data[offset + 4] << 3) | ((data[offset + 5] >> 5) & 0x07);
            const headerLength = protectionAbsent ? 7 : 9;
            const sampleRate = AAC_SAMPLE_RATES[sampleRateIndex];
            if (!sampleRate || frameLength < headerLength) { offset++; continue; }
            if (offset + frameLength > data.length) break;
            this.onAudio({
                ptsUs: Math.round(frameUs),
                data: data.subarray(offset + headerLength, offset + frameLength),
                objectType,
                sampleRate,
                channels,
                audioSpecificConfig: new Uint8Array([
                    (objectType << 3) | (sampleRateIndex >> 1),
                    ((sampleRateIndex & 0x01) << 7) | (channels << 3)
                ])
            });
            frameUs += 1024 * 1e6 / sampleRate;
            offset += frameLength;
        }
        if (offset < data.length) this.audioRemainder = { data: data.slice(offset), ptsUs: frameUs };
    }
}

function readTimestamp(data, i) {
    // 33 bits spread over 5 bytes; multiply rather than shift to stay above 32-bit integer math.
    return ((data[i] >> 1) & 0x07) * 1073741824
        + data[i + 1] * 4194304
        + ((data[i + 2] >> 1) & 0x7f) * 32768
        + data[i + 3] * 128
        + ((data[i + 4] >> 1) & 0x7f);
}

/** Yields [start, end) of each NAL unit body in an Annex-B buffer. */
function* nalUnits(data) {
    let start = -1;
    for (let i = 0; i + 2 < data.length; i++) {
        if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
            if (start >= 0) yield [start, i > 0 && data[i - 1] === 0 ? i - 1 : i];
            start = i + 3;
            i += 2;
        }
    }
    if (start >= 0 && start < data.length) yield [start, data.length];
}

/**
 * Reads an H.264 SPS NAL unit (header byte included) up to frame_mbs_only_flag.
 * frameMbsOnly === false means the stream may carry interlaced (field/MBAFF) pictures, which
 * browser WebCodecs decoders reject.
 */
function parseSps(nal) {
    // Drop emulation-prevention bytes (00 00 03 -> 00 00).
    const rbsp = [];
    for (let i = 1; i < nal.length; i++) {
        if (i >= 3 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
        rbsp.push(nal[i]);
    }
    let bit = 0;
    const u = (n) => {
        let value = 0;
        for (let i = 0; i < n; i++, bit++) value = value * 2 + ((rbsp[bit >> 3] >> (7 - (bit & 7))) & 1);
        return value;
    };
    const ue = () => {
        let zeros = 0;
        while (u(1) === 0 && zeros < 32) zeros++;
        return 2 ** zeros - 1 + u(zeros);
    };
    const se = () => { const k = ue(); return k & 1 ? (k + 1) / 2 : -k / 2; };

    const profileIdc = u(8);
    u(16); // constraint flags + level_idc
    ue(); // seq_parameter_set_id
    let chromaFormatIdc = 1, bitDepth = 8;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
        chromaFormatIdc = ue();
        if (chromaFormatIdc === 3) u(1);
        bitDepth = ue() + 8;
        ue(); // bit_depth_chroma_minus8
        u(1); // qpprime_y_zero_transform_bypass_flag
        if (u(1)) { // seq_scaling_matrix_present_flag
            for (let i = 0; i < (chromaFormatIdc === 3 ? 12 : 8); i++) {
                if (!u(1)) continue;
                let last = 8, next = 8;
                for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
                    if (next !== 0) next = (last + se() + 256) % 256;
                    last = next === 0 ? last : next;
                }
            }
        }
    }
    ue(); // log2_max_frame_num_minus4
    const pocType = ue();
    if (pocType === 0) ue();
    else if (pocType === 1) {
        u(1); se(); se();
        for (let i = ue(); i > 0; i--) se();
    }
    ue(); // max_num_ref_frames
    u(1); // gaps_in_frame_num_value_allowed_flag
    const widthMbs = ue() + 1;
    const heightMapUnits = ue() + 1;
    const frameMbsOnly = u(1) === 1;
    return {
        profileIdc, chromaFormatIdc, bitDepth, frameMbsOnly,
        width: widthMbs * 16,
        height: heightMapUnits * 16 * (frameMbsOnly ? 1 : 2)
    };
}

function concat(chunks, size) {
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
}

if (typeof self !== 'undefined') { self.TsDemuxer = TsDemuxer; self.parseSps = parseSps; }
if (typeof module !== 'undefined') module.exports = { TsDemuxer, readTimestamp, parseSps };
