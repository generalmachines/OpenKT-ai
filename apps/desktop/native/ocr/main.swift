// openkt-ocr — Apple Vision text recognition for one image, as JSON on stdout.
//
//   openkt-ocr <image> [--languages en-US,th-TH]
//
//   success (exit 0): {"text": "...", "lines": [{"text","x","y","w","h","confidence"}]}
//                     x, y, w, h are fractions of the image (0..1), origin at the TOP-left.
//   failure (exit ≠ 0): {"error": "..."}     2 = usage, 3 = unreadable image, 4 = Vision failed
//
// Interim runtime of Spec 03 §1a; the same code moves into the Swift engine later.
// Build: scripts/build-ocr.sh (swiftc -O -target arm64-apple-macos13 … -framework Vision -framework AppKit)

import AppKit
import Foundation
import ImageIO
import Vision

struct Line: Encodable {
    let text: String
    let x: Double
    let y: Double
    let w: Double
    let h: Double
    let confidence: Double
}

struct Output: Encodable {
    let text: String
    let lines: [Line]
}

func emit(_ data: Data) {
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func fail(_ message: String, code: Int32) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: ["error": message])) ?? Data("{\"error\":\"unknown\"}".utf8)
    emit(data)
    exit(code)
}

func round4(_ v: CGFloat) -> Double {
    return (Double(v) * 10000).rounded() / 10000
}

var imagePath: String? = nil
var languages: [String] = []
var args = Array(CommandLine.arguments.dropFirst())
while !args.isEmpty {
    let arg = args.removeFirst()
    if arg == "--languages" {
        guard !args.isEmpty else { fail("--languages needs a value, e.g. en-US,th-TH", code: 2) }
        languages = args.removeFirst().split(separator: ",").map { String($0) }
    } else if imagePath == nil {
        imagePath = arg
    } else {
        fail("unexpected argument: \(arg)", code: 2)
    }
}
guard let path = imagePath else { fail("usage: openkt-ocr <image> [--languages en-US,th-TH]", code: 2) }

let url = URL(fileURLWithPath: path)
guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
else { fail("cannot read an image at \(path)", code: 3) }

func recognise(cpuOnly: Bool) throws -> [VNRecognizedTextObservation] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    if #available(macOS 13.0, *) {
        request.automaticallyDetectsLanguage = true
    }
    if !languages.isEmpty {
        request.recognitionLanguages = languages
    }
    if cpuOnly {
        request.usesCPUOnly = true
    }
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    return request.results ?? []
}

var observations: [VNRecognizedTextObservation] = []
do {
    observations = try recognise(cpuOnly: false)
} catch let first {
    // Machines without a usable GPU / Neural Engine (virtual machines): once more on the CPU.
    do {
        observations = try recognise(cpuOnly: true)
    } catch let second {
        fail("Vision could not read the image: \(first.localizedDescription); on the CPU: \(second.localizedDescription)", code: 4)
    }
}

var lines: [Line] = []
for observation in observations {
    guard let best = observation.topCandidates(1).first else { continue }
    let text = best.string.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty { continue }
    let box = observation.boundingBox // normalised, origin bottom-left
    lines.append(Line(text: text, x: round4(box.minX), y: round4(1 - box.maxY), w: round4(box.width), h: round4(box.height), confidence: round4(CGFloat(best.confidence))))
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.withoutEscapingSlashes]
do {
    emit(try encoder.encode(Output(text: lines.map { $0.text }.joined(separator: "\n"), lines: lines)))
} catch {
    fail("could not encode the result: \(error.localizedDescription)", code: 4)
}
