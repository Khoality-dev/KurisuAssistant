"""Convert a HuggingFace Whisper model to CTranslate2 format for faster-whisper.

Usage:
    python scripts/convert_whisper.py [--model whisper-finetuned] [--output data/asr/whisper-ct2] [--quantization float16]
"""

import argparse
import os
import shutil


def main():
    parser = argparse.ArgumentParser(description="Convert HuggingFace Whisper to CTranslate2")
    parser.add_argument("--model", default="whisper-finetuned", help="Path to HuggingFace model directory")
    parser.add_argument("--output", default="data/asr/whisper-ct2", help="Output directory for CT2 model")
    parser.add_argument("--quantization", default="float16", choices=["float16", "float32", "int8", "int8_float16"])
    args = parser.parse_args()

    if not os.path.exists(args.model):
        print(f"Error: Model directory '{args.model}' not found")
        return 1

    print(f"Loading model from {args.model}...")
    import ctranslate2
    import transformers

    model = transformers.WhisperForConditionalGeneration.from_pretrained(args.model)

    converter = ctranslate2.converters.TransformersConverter(args.model)
    converter.load_model = lambda *a, **kw: model

    print(f"Converting to CTranslate2 ({args.quantization}) -> {args.output}")
    os.makedirs(args.output, exist_ok=True)
    converter.convert(args.output, quantization=args.quantization)

    # Copy tokenizer/preprocessor files
    for filename in ["preprocessor_config.json", "tokenizer_config.json", "vocab.json", "normalizer.json"]:
        src = os.path.join(args.model, filename)
        if os.path.exists(src):
            shutil.copy2(src, args.output)
            print(f"  Copied {filename}")

    print("Done!")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
