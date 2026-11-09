// Plat icoon uit de lagen (voor de .icns en Finder-voorbeelden): afgeronde vorm met marge, zoals macOS-iconen.
// swift make_flat.swift <RRGGBB> <uit.png> <laag.png>...
import AppKit

let args = CommandLine.arguments
let v = UInt32(args[1], radix: 16)!
let space = CGColorSpace(name: CGColorSpace.sRGB)!
let ctx = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
let box = CGRect(x: 100, y: 100, width: 824, height: 824)
ctx.addPath(CGPath(roundedRect: box, cornerWidth: 185, cornerHeight: 185, transform: nil))
ctx.clip()
ctx.setFillColor(CGColor(srgbRed: CGFloat(v >> 16 & 255) / 255, green: CGFloat(v >> 8 & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: 1))
ctx.fill(box)
ctx.interpolationQuality = .high
for path in args.dropFirst(3) {
  let rep = NSBitmapImageRep(data: try! Data(contentsOf: URL(fileURLWithPath: path)))!
  ctx.draw(rep.cgImage!, in: box)
}
let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
