import logo from '../assets/linear.svg';

export default function LinearLogo({ size = 20 }) {
  return <span className="linear-logo" style={{ width: size, height: size, maskImage: `url("${logo}")` }} aria-hidden="true" />;
}
