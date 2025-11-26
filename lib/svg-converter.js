// SVG Converter
// Based on tuhi's export.py JsonSvg implementation

class SVGConverter {
  constructor() {
    this.outputScalingFactor = 1000;
    this.basePenWidth = 0.4;
    this.penPressureWidthFactor = 0.2;
    this.widthPrecision = 10;
  }

  convert({dimensions, strokes}) {
    // Calculate dimensions - ensure they're not zero
    let width = dimensions[0] / this.outputScalingFactor;
    let height = dimensions[1] / this.outputScalingFactor;
    
    if (width === 0 || height === 0) {
      width = 100;
      height = 100;
    }
    
    // SVG header
    let svg = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    svg += `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}">\n`;
    svg += `  <g id="layer0">\n`;
    
    // Convert strokes
    for (let strokeIdx = 0; strokeIdx < strokes.length; strokeIdx++) {
      const stroke = strokes[strokeIdx];
      if (stroke.length === 0) continue;

      let pathData = null;
      let currentStrokeWidth = null;
      let pathId = 0;

      for (const point of stroke) {
        const x = point.x / this.outputScalingFactor;
        const y = point.y / this.outputScalingFactor;

        // Skip invalid coordinates
        if (isNaN(x) || isNaN(y) || !isFinite(x) || !isFinite(y)) {
          continue;
        }

        // Calculate stroke width from pressure
        const delta = (point.p - 0x8000) / 0x8000;
        let strokeWidth = this.basePenWidth + this.penPressureWidthFactor * delta;

        // Reduce precision
        strokeWidth = Math.floor(strokeWidth * this.widthPrecision) / this.widthPrecision;

        // Convert to pixels (mm to px at 96dpi)
        const widthPx = strokeWidth * 0.26458;

        // Create new path if stroke width changed
        if (currentStrokeWidth !== strokeWidth) {
          if (pathData) {
            svg += `    <path id="sk_${strokeIdx}_${pathId}" style="fill:none;stroke:black;stroke-width:${widthPx.toFixed(2)}" d="${pathData}"/>\n`;
            pathId++;
          }
          pathData = `M ${x.toFixed(2)} ${y.toFixed(2)}`;
          currentStrokeWidth = strokeWidth;
        } else {
          // Continue path
          pathData += ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
        }
      }

      // Close last path
      if (pathData) {
        svg += `    <path id="sk_${strokeIdx}_${pathId}" style="fill:none;stroke:black;stroke-width:${currentStrokeWidth * 0.26458}" d="${pathData}"/>\n`;
      }
    }
    
    svg += `  </g>\n`;
    svg += `</svg>\n`;
    
    return svg;
  }
}

export default SVGConverter;

