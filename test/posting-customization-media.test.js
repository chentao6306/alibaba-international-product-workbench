import test from 'node:test';
import assert from 'node:assert/strict';
import { hotspotMatches, readHotspotCanvas } from '../server/posting-customization-media.js';

test('hotspot verification compares percentages against each image instead of accepting a default rectangle', () => {
  const expected = { x: 20, y: 35, width: 35, height: 15 };
  for (const [width, height] of [[780, 780], [1200, 600], [400, 1600]]) {
    const image = { imageSize: { width, height }, customizableAreas: [{ shape: 'rect',
      x: width * .2, y: height * .35, width: width * .35, height: height * .15 }] };
    assert.equal(hotspotMatches(image, expected), true);
    assert.equal(hotspotMatches({ ...image, customizableAreas: [{ shape: 'rect', x: width * .375, y: height * .375, width: width * .25, height: height * .25 }] }, expected), false);
    assert.equal(hotspotMatches({ ...image, customizableAreas: [...image.customizableAreas, image.customizableAreas[0]] }, expected), false);
  }
  assert.equal(hotspotMatches({}, expected), false);
});

test('hotspot geometry uses the visible top-left when resizing changes a shape origin to its center', () => {
  const node = {};
  const shape = { type: 'rect', selectable: true, left: 200, top: 150, originX: 'center', originY: 'center', width: 100, height: 40,
    scaleX: 2, scaleY: 1, getPointByOrigin: (x, y) => { assert.equal(x, 'left'); assert.equal(y, 'top'); return { x: 100, y: 130 }; },
    oCoords: { mr: { x: 300, y: 150 }, mb: { x: 200, y: 170 } } };
  node.__reactFiberTest = { memoizedState: { memoizedState: { current: { lowerCanvasEl: node, width: 512, height: 512,
    backgroundImage: { getBoundingRect: () => ({ left: 0, top: 128, width: 512, height: 256 }) }, _objects: [shape] } } } };
  assert.deepEqual(readHotspotCanvas(node).area, { x: 100, y: 130, width: 200, height: 40 });
  node.__reactFiberTest.memoizedState.memoizedState.current._objects.push({ ...shape });
  assert.equal(readHotspotCanvas(node), null);
});
