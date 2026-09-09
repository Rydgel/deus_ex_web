import { Matrix4, Euler } from 'three';
import { toView } from '../unreal/geometry.mjs';

/** Brush-local geometry: remove PrePivot, MainScale, rotate, PostScale, translate. */
export function brushMatrix(values) {
  if (values.MainScale?.shearRate || values.PostScale?.shearRate) throw new Error('Sheared moving brush is not yet supported');
  const [pitch, yaw, roll] = (values.Rotation ?? [0, 0, 0]).map(n => n * Math.PI / 32768);
  const scale = values.MainScale?.scale ?? [1, 1, 1], post = values.PostScale?.scale ?? [1, 1, 1];
  const pivot = toView(values.PrePivot ?? [0, 0, 0]);
  const matrix = new Matrix4().makeTranslation(...pivot.map(n => -n));
  matrix.premultiply(new Matrix4().makeScale(scale[1], scale[2], scale[0]));
  matrix.premultiply(new Matrix4().makeRotationFromEuler(new Euler(pitch, -yaw, -roll, 'YXZ')));
  matrix.premultiply(new Matrix4().makeScale(post[1], post[2], post[0]));
  matrix.premultiply(new Matrix4().makeTranslation(...toView(values.Location ?? [0, 0, 0])));
  return matrix;
}
