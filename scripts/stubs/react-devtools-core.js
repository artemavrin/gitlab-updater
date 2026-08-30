/**
 * Ink тянет react-devtools-core только при DEV=true. В бандл для сервера
 * девтулзы не едут, поэтому подменяем заглушкой, которая честно говорит,
 * что произошло, вместо «undefined is not a function».
 */
const unavailable = () => {
  throw new Error('react-devtools-core is not bundled; unset DEV to run gitlab-upgrade');
};
export default { initialize: unavailable, connectToDevTools: unavailable };
