/// Incremental byte framing. CRLF is one line ending even across network chunks.
/// Only the current frame is retained; the caller handles each completed frame immediately.
pub(crate) struct SseFramer {
    buffer: Vec<u8>,
    line_bytes: usize,
    skip_lf: bool,
    frame_bytes: usize,
    max_frame_bytes: usize,
}

const MAX_FRAME_BYTES: usize = 1024 * 1024;

impl SseFramer {
    pub(crate) fn new() -> Self {
        Self::with_limit(MAX_FRAME_BYTES)
    }

    pub(crate) fn with_limit(max_frame_bytes: usize) -> Self {
        Self {
            buffer: Vec::new(),
            line_bytes: 0,
            skip_lf: false,
            frame_bytes: 0,
            max_frame_bytes,
        }
    }

    pub(crate) fn push(&mut self, byte: u8) -> Result<Option<Vec<u8>>, &'static str> {
        if self.skip_lf {
            self.skip_lf = false;
            if byte == b'\n' {
                return Ok(None);
            }
        }
        self.frame_bytes += 1;
        if self.frame_bytes > self.max_frame_bytes {
            return Err("SSE frame exceeds maximum size");
        }
        if byte == b'\r' || byte == b'\n' {
            self.skip_lf = byte == b'\r';
            if self.line_bytes == 0 {
                self.frame_bytes = 0;
                return Ok(Some(std::mem::take(&mut self.buffer)));
            }
            self.line_bytes = 0;
            self.buffer.push(b'\n');
        } else {
            self.line_bytes += 1;
            self.buffer.push(byte);
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_across_crlf_boundaries_without_extra_events() {
        let mut framer = SseFramer::new();
        let mut frames = Vec::new();
        for &byte in b"event: a\r\ndata: {}\r\n\r\nevent: b\ndata: 1\n\n" {
            if let Some(frame) = framer.push(byte).unwrap() {
                frames.push(frame);
            }
        }
        assert_eq!(
            frames,
            vec![
                b"event: a\ndata: {}\n".to_vec(),
                b"event: b\ndata: 1\n".to_vec()
            ]
        );
    }

    #[test]
    fn supports_each_line_ending_and_discards_no_incomplete_data() {
        for ending in [b"\n".as_slice(), b"\r", b"\r\n"] {
            let mut framer = SseFramer::new();
            for &byte in b"data:1".iter().chain(ending) {
                assert!(framer.push(byte).unwrap().is_none());
            }
            let frames: Vec<_> = ending
                .iter()
                .filter_map(|byte| framer.push(*byte).unwrap())
                .collect();
            assert_eq!(frames, vec![b"data:1\n".to_vec()]);
        }
    }

    #[test]
    fn enforces_the_callers_smaller_budget_on_complete_frames_too() {
        let mut framer = SseFramer::with_limit(8);
        for &byte in b"data:123" {
            assert!(framer.push(byte).unwrap().is_none());
        }
        assert!(framer.push(b'\n').is_err());
    }

    #[test]
    fn rejects_unterminated_frame_at_the_limit() {
        let mut framer = SseFramer::new();
        for _ in 0..MAX_FRAME_BYTES {
            assert!(framer.push(b'x').unwrap().is_none());
        }
        assert!(framer.push(b'x').is_err());
        assert_eq!(framer.buffer.len(), MAX_FRAME_BYTES);
    }

    #[test]
    fn multiline_frames_share_one_budget() {
        let mut framer = SseFramer::new();
        for byte in b"data:x\n".iter().cycle().take(MAX_FRAME_BYTES) {
            assert!(framer.push(*byte).unwrap().is_none());
        }
        assert!(framer.push(b'x').is_err());
    }

    #[test]
    fn completed_frames_reset_the_budget() {
        let mut framer = SseFramer::new();
        for _ in 0..3 {
            for _ in 0..MAX_FRAME_BYTES - 2 {
                assert!(framer.push(b'x').unwrap().is_none());
            }
            assert!(framer.push(b'\n').unwrap().is_none());
            assert!(framer.push(b'\n').unwrap().is_some());
            assert!(framer.buffer.is_empty());
        }
    }
}
