// Stamps a version string onto an app icon (macOS only; CoreGraphics/CoreText, no dependencies).
//
//   swift scripts/watermark-icon.swift <in.png> <out.png> <text>
//
// Layout, measured from the icon's opaque body (the rounded square, not the shadow/padding):
// - top-left corner, left/top margin = 8% of the body width
// - bottom of the text (baseline; digits have no descenders) 1/5 of the way down the body
// - condensed bold system font, as large as fits between the top margin and the baseline,
//   shrunk if needed so at least 8 digits fit in one row inside the margins
// - dark blue
import AppKit
import CoreText
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count == 4 else {
    FileHandle.standardError.write("usage: watermark-icon.swift <in.png> <out.png> <text>\n".data(using: .utf8)!)
    exit(2)
}
let (input, output, text) = (args[1], args[2], args[3])

guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: input) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(src, 0, nil)
else { fatalError("can't read \(input)") }
let (w, h) = (image.width, image.height)

// RGBA bitmap, top row first in memory (we flip the CTM so drawing is in top-left coordinates too).
let ctx = CGContext(
    data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
    space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
)!
ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))

// Opaque body bounds (alpha >= 250 skips the soft shadow). Rows in memory run top to bottom.
let px = ctx.data!.bindMemory(to: UInt8.self, capacity: w * h * 4)
var (minX, minY, maxX, maxY) = (w, h, -1, -1)
for y in 0..<h {
    for x in 0..<w where px[(y * w + x) * 4 + 3] >= 250 {
        minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
    }
}
if maxX < 0 { (minX, minY, maxX, maxY) = (0, 0, w - 1, h - 1) }  // fully transparent: use the canvas
let bodyW = CGFloat(maxX - minX + 1), bodyH = CGFloat(maxY - minY + 1)

let margin = bodyW * 0.08
let left = CGFloat(minX) + margin
let baseline = CGFloat(minY) + bodyH / 5  // distance from the top edge of the canvas

func font(_ size: CGFloat) -> NSFont { NSFont.systemFont(ofSize: size, weight: .bold, width: .condensed) }
func width(_ s: String, _ f: NSFont) -> CGFloat {
    CTLineGetTypographicBounds(CTLineCreateWithAttributedString(NSAttributedString(string: s, attributes: [.font: f])), nil, nil, nil)
}
// Size so the cap height spans top margin -> baseline, then cap it so 8 digits fit across.
var size = (baseline - CGFloat(minY) - margin) / font(100).capHeight * 100
let fitWidth = bodyW - 2 * margin
let eight = width("88888888", font(size))
if eight > fitWidth { size *= fitWidth / eight }
let f = font(size)

let color = CGColor(srgbRed: 13 / 255, green: 44 / 255, blue: 110 / 255, alpha: 1)  // #0D2C6E
let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [.font: f, .foregroundColor: color]))
ctx.textMatrix = .identity
// CG's origin is bottom-left: baseline measured from the top becomes h - baseline.
ctx.textPosition = CGPoint(x: left, y: CGFloat(h) - baseline)
CTLineDraw(line, ctx)

let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: output) as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
guard CGImageDestinationFinalize(dest) else { fatalError("can't write \(output)") }
print(String(format: "watermark %@: body %.0fx%.0f at (%d,%d), font %.0fpx, 8 digits = %.0fpx of %.0fpx",
             text, bodyW, bodyH, minX, minY, size, width("88888888", f), fitWidth))
