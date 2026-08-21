//! Diffusion kernels — mirror of the `KERNELS` table in algorithms.ts.
//!
//! Taps are `(dx, dy, weight)`; `divisor` is present only where a kernel
//! deliberately discards energy (Atkinson).

pub struct Kernel {
    pub name: &'static str,
    pub taps: &'static [(i32, i32, f64)],
    pub divisor: Option<f64>,
}

macro_rules! taps {
    ($($x:expr, $y:expr, $w:expr);* $(;)?) => {
        &[$(($x, $y, $w)),+]
    };
}

const INTEGER_KERNELS: &[Kernel] = &[
    Kernel {
        name: "floyd-steinberg",
        taps: taps!(1, 0, 7.0; -1, 1, 3.0; 0, 1, 5.0; 1, 1, 1.0),
        divisor: None,
    },
    Kernel {
        name: "false-floyd-steinberg",
        taps: taps!(1, 0, 3.0; 0, 1, 3.0; 1, 1, 2.0),
        divisor: None,
    },
    Kernel {
        name: "jarvis-judice-ninke",
        taps: taps!(
            1, 0, 7.0; 2, 0, 5.0;
            -2, 1, 3.0; -1, 1, 5.0; 0, 1, 7.0; 1, 1, 5.0; 2, 1, 3.0;
            -2, 2, 1.0; -1, 2, 3.0; 0, 2, 5.0; 1, 2, 3.0; 2, 2, 1.0
        ),
        divisor: None,
    },
    Kernel {
        name: "stucki",
        taps: taps!(
            1, 0, 8.0; 2, 0, 4.0;
            -2, 1, 2.0; -1, 1, 4.0; 0, 1, 8.0; 1, 1, 4.0; 2, 1, 2.0;
            -2, 2, 1.0; -1, 2, 2.0; 0, 2, 4.0; 1, 2, 2.0; 2, 2, 1.0
        ),
        divisor: None,
    },
    Kernel {
        name: "burkes",
        taps: taps!(
            1, 0, 8.0; 2, 0, 4.0;
            -2, 1, 2.0; -1, 1, 4.0; 0, 1, 8.0; 1, 1, 4.0; 2, 1, 2.0
        ),
        divisor: None,
    },
    Kernel {
        name: "sierra",
        taps: taps!(
            1, 0, 5.0; 2, 0, 3.0;
            -2, 1, 2.0; -1, 1, 4.0; 0, 1, 5.0; 1, 1, 4.0; 2, 1, 2.0;
            -1, 2, 2.0; 0, 2, 3.0; 1, 2, 2.0
        ),
        divisor: None,
    },
    Kernel {
        name: "sierra-two-row",
        taps: taps!(
            1, 0, 4.0; 2, 0, 3.0;
            -2, 1, 1.0; -1, 1, 2.0; 0, 1, 3.0; 1, 1, 2.0; 2, 1, 1.0
        ),
        divisor: None,
    },
    Kernel {
        name: "sierra-lite",
        taps: taps!(1, 0, 2.0; -1, 1, 1.0; 0, 1, 1.0),
        divisor: None,
    },
    Kernel {
        name: "stevenson-arce",
        taps: taps!(
            2, 0, 32.0;
            -3, 1, 12.0; -1, 1, 26.0; 1, 1, 30.0; 3, 1, 16.0;
            -2, 2, 12.0; 0, 2, 26.0; 2, 2, 12.0;
            -3, 3, 5.0; -1, 3, 12.0; 1, 3, 12.0; 3, 3, 5.0
        ),
        divisor: None,
    },
    Kernel {
        name: "fan",
        taps: taps!(1, 0, 7.0; -2, 1, 1.0; -1, 1, 3.0; 0, 1, 5.0),
        divisor: None,
    },
    Kernel {
        name: "shiau-fan",
        taps: taps!(1, 0, 4.0; -2, 1, 1.0; -1, 1, 1.0; 0, 1, 2.0),
        divisor: None,
    },
    Kernel {
        name: "shiau-fan-2",
        taps: taps!(1, 0, 8.0; -3, 1, 1.0; -2, 1, 1.0; -1, 1, 2.0; 0, 1, 4.0),
        divisor: None,
    },
    Kernel {
        name: "pigeon",
        taps: taps!(
            1, 0, 2.0; 2, 0, 1.0;
            -1, 1, 2.0; 0, 1, 2.0; 1, 1, 2.0;
            -1, 2, 1.0; 1, 2, 1.0
        ),
        divisor: None,
    },
    Kernel {
        name: "simple-2d",
        taps: taps!(1, 0, 1.0; 0, 1, 1.0),
        divisor: None,
    },
    // Six unit taps over a divisor of eight: a quarter of the error is thrown
    // away on purpose — the crisp early-Mac look and the blown highlights.
    Kernel {
        name: "atkinson",
        taps: taps!(1, 0, 1.0; 2, 0, 1.0; -1, 1, 1.0; 0, 1, 1.0; 1, 1, 1.0; 0, 2, 1.0),
        divisor: Some(8.0),
    },
];

fn divisor_of(k: &Kernel) -> f64 {
    if let Some(d) = k.divisor {
        return d;
    }
    let sum: f64 = k.taps.iter().map(|t| t.2).sum();
    if sum == 0.0 { 1.0 } else { sum }
}

pub fn kernel_for(algorithm: &str) -> Option<(&'static Kernel, f64)> {
    INTEGER_KERNELS
        .iter()
        .find(|k| k.name == algorithm)
        .map(|k| (k, divisor_of(k)))
}

/// The diffusion-family fallback, matching the TS dispatcher's default arm.
pub fn default_kernel() -> (&'static Kernel, f64) {
    kernel_for("floyd-steinberg").unwrap()
}
