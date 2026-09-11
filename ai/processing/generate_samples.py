#!/usr/bin/env python3
"""
Generates synthetic emergency voice radio dispatches in WAV format
for 1-click live demo and judge evaluation.
"""

import os
import numpy as np
import soundfile as sf

def generate_emergency_samples():
    output_dir = os.path.join(os.path.dirname(__file__), "..", "..", "public", "samples")
    os.makedirs(output_dir, exist_ok=True)
    sr = 22050

    # Sample 1: Critical Flood Mayday (frantic, high pitch modulation, high energy)
    duration = 4.0
    t = np.linspace(0, duration, int(sr * duration), endpoint=False)
    # Pitch modulation 280Hz - 420Hz (high vocal distress pitch)
    pitch_mod = 320 + 80 * np.sin(2 * np.pi * 3.5 * t)
    carrier = np.sin(2 * np.pi * pitch_mod * t)
    # Rapid syllable burst envelope (approx 4.5 syllables / sec)
    envelope = np.clip(np.sin(2 * np.pi * 4.2 * t), 0.1, 1.0)
    # Radio static / background noise
    noise = np.random.normal(0, 0.04, len(t))
    signal_critical = (carrier * envelope * 0.75 + noise).astype(np.float32)
    sf.write(os.path.join(output_dir, "critical_mayday.wav"), signal_critical, sr)

    # Sample 2: Urgent Earthquake Call (high energy bursts)
    duration = 3.5
    t2 = np.linspace(0, duration, int(sr * duration), endpoint=False)
    pitch_mod2 = 240 + 60 * np.sin(2 * np.pi * 2.8 * t2)
    carrier2 = np.sin(2 * np.pi * pitch_mod2 * t2)
    envelope2 = np.clip(np.sin(2 * np.pi * 3.2 * t2), 0.15, 0.9)
    noise2 = np.random.normal(0, 0.05, len(t2))
    signal_urgent = (carrier2 * envelope2 * 0.65 + noise2).astype(np.float32)
    sf.write(os.path.join(output_dir, "urgent_earthquake.wav"), signal_urgent, sr)

    # Sample 3: Moderate Routine Sitrep (calm, steady, lower pitch, low energy)
    duration = 3.0
    t3 = np.linspace(0, duration, int(sr * duration), endpoint=False)
    pitch_mod3 = 135 + 15 * np.sin(2 * np.pi * 1.2 * t3)
    carrier3 = np.sin(2 * np.pi * pitch_mod3 * t3)
    envelope3 = np.clip(np.sin(2 * np.pi * 2.0 * t3), 0.2, 0.7)
    noise3 = np.random.normal(0, 0.02, len(t3))
    signal_calm = (carrier3 * envelope3 * 0.4 + noise3).astype(np.float32)
    sf.write(os.path.join(output_dir, "moderate_sitrep.wav"), signal_calm, sr)

    print("Generated 3 emergency audio samples in:", output_dir)

if __name__ == "__main__":
    generate_emergency_samples()
