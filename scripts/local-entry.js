// Wrangler's local workerd cannot instantiate jurisdiction-restricted namespaces.
// This entrypoint is selected only by npm run dev. Deployments use src/worker.js.
import worker, {Assessment} from '../src/worker.js';
export {Assessment};
function localBindings(env) {
  return {
    ...env,
    ATTEMPTS: { jurisdiction(region) {
      if (region !== 'eu') throw new Error('Expected EU Durable Object binding.');
      return env.ATTEMPTS;
    } }
  };
}
export default {
  fetch(request,env,ctx) {return worker.fetch(request,localBindings(env),ctx);},
  scheduled(event,env,ctx) {return worker.scheduled(event,localBindings(env),ctx);}
};
