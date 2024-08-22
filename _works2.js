addEventListener("fetch", (event) => {
  event.passThroughOnException();
  event.respondWith(handleRequest(event.request));
});

const dockerHub = "https://registry-1.docker.io";
const HTML = `
<!DOCTYPE html>
	<html>
	<head>
	<title>Welcome to nginx!</title>
	<style>
		body {
			width: 35em;
			margin: 0 auto;
			font-family: Tahoma, Verdana, Arial, sans-serif;
		}
	</style>
	</head>
	<body>
	<h1>Welcome to nginx!</h1>
	<p>If you see this page, the nginx web server is successfully installed and
	working. Further configuration is required.</p>
	
	<p>For online documentation and support please refer to
	<a href="http://nginx.org/">nginx.org</a>.<br/>
	Commercial support is available at
	<a href="http://nginx.com/">nginx.com</a>.</p>
	
	<p><em>Thank you for using nginx.</em></p>
	</body>
	</html>
`

const routes = {
  // 替换为你的域名
  "dockerhub.aiexanders.us.kg": dockerHub,
};

function routeByHosts(host) {
  if (host in routes) {
    return routes[host];
  }
  return "";
}

async function handleRequest(request) {

  const url = new URL(request.url);

  if (url.pathname == "/") {
    return handleHomeRequest(url.host);
  }

  const upstream = routeByHosts(url.hostname);
  if (!upstream) {
    return createNotFoundResponse(routes);
  }

  const isDockerHub = upstream == dockerHub;
  const authorization = request.headers.get("Authorization");
  if (url.pathname == "/v2/") {
    return handleFirstRequest(upstream, authorization, url.hostname);
  }
  // get token
  if (url.pathname == "/v2/auth") {
    return handleAuthRequest(upstream, url, isDockerHub, authorization);
  }
  // redirect for DockerHub library images
  // Example: /v2/busybox/manifests/latest => /v2/library/busybox/manifests/latest
  if (isDockerHub) {
    const pathParts = url.pathname.split("/");
    if (pathParts.length == 5) {
      pathParts.splice(2, 0, "library");
      const redirectUrl = new URL(url);
      redirectUrl.pathname = pathParts.join("/");
      return Response.redirect(redirectUrl.toString(), 301);
    }
  }
  return handlePullRequest(upstream, request);
}

function parseAuthenticate(authenticateStr) {
  // sample: Bearer realm="https://auth.ipv6.docker.com/token",service="registry.docker.io"
  // match strings after =" and before "
  const re = /(?<=\=")(?:\\.|[^"\\])*(?=")/g;
  const matches = authenticateStr.match(re);
  if (matches == null || matches.length < 2) {
    throw new Error(`invalid Www-Authenticate Header: ${authenticateStr}`);
  }
  return {
    realm: matches[0],
    service: matches[1],
  };
}

async function fetchToken(wwwAuthenticate, scope, authorization) {
  const url = new URL(wwwAuthenticate.realm);
  if (wwwAuthenticate.service.length) {
    url.searchParams.set("service", wwwAuthenticate.service);
  }
  if (scope) {
    url.searchParams.set("scope", scope);
  }
  const headers = new Headers();
  if (authorization) {
    headers.set("Authorization", authorization);
  }
  return await fetch(url, { method: "GET", headers: headers });
}

function handleHomeRequest(host) {
  return new Response(HTML.replace(/{:host}/g, host), {
    status: 200,
    headers: {
      "content-type": "text/html",
    }
  })
}

async function handlePullRequest(upstream, request) {
  const url = new URL(request.url);
  const newUrl = new URL(upstream + url.pathname);
  const newReq = new Request(newUrl, {
    method: request.method,
    headers: request.headers,
    redirect: "follow",
  });
  return await fetch(newReq);
}

async function handleFirstRequest(upstream, authorization, hostname) {
  const newUrl = new URL(upstream + "/v2/");
  const headers = new Headers();
  if (authorization) {
    headers.set("Authorization", authorization);
  }
  // check if need to authenticate
  const resp = await fetch(newUrl.toString(), {
    method: "GET",
    headers: headers,
    redirect: "follow",
  });
  if (resp.status === 401) {
      headers.set(
        "Www-Authenticate",
        `Bearer realm="https://${hostname}/v2/auth",service="cloudflare-docker-proxy"`
      );
    return new Response(JSON.stringify({ message: "Unauthorized" }), {
      status: 401,
      headers: headers,
    });
  } else {
    return resp;
  }
}

async function handleAuthRequest(upstream, url, isDockerHub, authorization) {
  const newUrl = new URL(upstream + "/v2/");
  const resp = await fetch(newUrl.toString(), {
    method: "GET",
    redirect: "follow",
  });
  if (resp.status !== 401) {
    return resp;
  }
  const authenticateStr = resp.headers.get("WWW-Authenticate");
  if (authenticateStr === null) {
    return resp;
  }
  const wwwAuthenticate = parseAuthenticate(authenticateStr);
  let scope = url.searchParams.get("scope");
  // autocomplete repo part into scope for DockerHub library images
  // Example: repository:busybox:pull => repository:library/busybox:pull
  if (scope && isDockerHub) {
    let scopeParts = scope.split(":");
    if (scopeParts.length == 3 && !scopeParts[1].includes("/")) {
      scopeParts[1] = "library/" + scopeParts[1];
      scope = scopeParts.join(":");
    }
  }
  return await fetchToken(wwwAuthenticate, scope, authorization);
}

const createNotFoundResponse = (routes) => new Response(
  JSON.stringify({ routes }),
  {
    status: 404,
    headers: {
      "Content-Type": "application/json",
    },
  }
);
