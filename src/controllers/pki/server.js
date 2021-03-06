/**
* @Author: BingWu Yang <detailyang>
* @Date:   2016-03-13T22:06:56+08:00
* @Email:  detailyang@gmail.com
* @Last modified by:   detailyang
* @Last modified time: 2016-07-05T11:27:20+08:00
* @License: The MIT License (MIT)
*/


import { readFileSync } from 'fs';
import sequelize from 'sequelize';


import config from '../../config';
import models from '../../models';
import utils from '../../utils';
import { isNumeric } from '../../utils/number';
import { pushdSync, popdSync, exec } from '../../utils/shell';


module.exports = {
  async getKey(ctx) {
    const id = ctx.params.id;
    const server = await models.pki.findOne({
      attributes: ['id', 'key', 'name'],
      where: {
        id,
        is_delete: false,
      },
    });

    if (!server) {
      throw new utils.error.NotFoundError('dont find server key');
    }

    ctx.type = 'application/octet-stream';
    ctx.set('Content-Disposition', `attachment; filename=\"${server.name}.key\"`);
    ctx.body = server.key;
  },

  async getCrt(ctx) {
    const id = ctx.params.id;
    const server = await models.pki.findOne({
      attributes: ['id', 'crt', 'name'],
      where: {
        id,
        is_delete: false,
      },
    });

    if (!server) {
      throw new utils.error.NotFoundError('dont find server crt');
    }

    ctx.type = 'application/octet-stream';
    ctx.set('Content-Disposition', `attachment; filename=\"${server.name}.crt\"`);
    ctx.body = server.crt;
  },

  async getCsr(ctx) {
    const id = ctx.params.id;
    const server = await models.pki.findOne({
      attributes: ['id', 'csr', 'name'],
      where: {
        id,
        is_delete: false,
      },
    });

    if (!server) {
      throw new utils.error.NotFoundError('dont find server csr');
    }

    ctx.type = 'application/octet-stream';
    ctx.set('Content-Disposition', `attachment; filename=\"${server.name}.csr\"`);
    ctx.body = server.csr;
  },

  async getPkcs12(ctx) {
    const id = ctx.params.id;
    const server = await models.pki.findOne({
      attributes: ['id', 'pkcs12', 'name'],
      where: {
        id,
        is_delete: false,
      },
    });

    if (!server) {
      throw new utils.error.NotFoundError('dont find server pkcs12');
    }

    ctx.type = 'application/octet-stream';
    ctx.set('Content-Disposition', `attachment; filename=\"${server.name}.p12\"`);
    ctx.body = server.pkcs12;
  },

  async delete(ctx) {
    const id = ctx.params.id;
    const pki = await models.pki.update({
      is_delete: 1,
    }, {
      where: {
        id,
      },
    });
    if (!pki) {
      throw new utils.error.ServerError('delete server pki error');
    }

    ctx.body = ctx.return;
  },

  async get(ctx) {
    const keyword = ctx.request.query.keyword || '';
    const where = {
      is_delete: 0,
    };

    if (keyword.length > 0) {
      where.name = {
        $like: `%${keyword}%`,
      };
      where.type = 0;
    }

    // it's not necessary to await in parallel for performance
    const pkis = await models.pki.findAll({
      attributes: ['id', 'name', 'days', 'created_at'],
      where: where,
      offset: (ctx.request.page - 1) * ctx.request.per_page,
      limit: ctx.request.per_page,
    });
    if (!pkis) {
      throw new utils.error.NotFoundError('dont find any pki');
    }
    const count = await models.pki.findOne({
      attributes: [
        [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
      ],
      where: where,
    });
    ctx.return.data = {
      value: pkis,
      total: count.dataValues.count,
      per_page: ctx.request.per_page,
      page: ctx.request.page,
    };
    ctx.body = ctx.return;
  },

  async post(ctx) {
    let pki = {
      id: 0,
    };
    let dsan = '';
    let x509dsan = '';
    let cn = ctx.request.body.commonname || '';
    const password = ctx.request.body.password || config.pki.password;
    const days = ctx.request.body.days || config.pki.days;

    if (!isNumeric(days)) {
      throw new utils.error.ParamsError('days should be number');
    }
    if (password.length < 4) {
      throw new utils.error.ParamsError('cert password should be greate than 4');
    }
    if (password.indexOf(' ') >= 0) {
      throw new utils.error.ParamsError('cert password cannot include whitespace');
    }
    if (cn instanceof Array) {
      if (!cn.length) {
        throw new utils.error.ParamsError('common name cannot be empty');
      }
      dsan = cn.map((e, i) => `DNS:${e}`).join(',');
      x509dsan = '\\nsubjectAltName=' + cn.map((e, i) => `DNS.${i}:${e}`).join(',');
      cn = `CN=${cn[0]}`;
    } else {
      if (cn === '') {
        throw new utils.error.ParamsError('commonname cannot be empty');
      }
      cn = `CN=${cn}`;
    }
    const encodedcn = cn.replace(/\*/g, 'wildcard').replace(/\//g, '-');
    if (encodedcn.length <= 3) {
      throw new utils.error.ParamsError('common name cannot be empty');
    }
    if (encodedcn.indexOf(' ') >= 0) {
      throw new utils.error.ParamsError('common name cannot include whitespace');
    }

    // Actually, CAS dont care work directory
    pushdSync(config.pki.dir);
    try {
      const key = await exec(`openssl genrsa -des3 -out ${encodedcn}.key `
                           + `-passout pass:${password} 2048`);
      if (key.code) {
        throw new utils.error.ServerError('generate rsa error');
      }

      const csr = await exec(`openssl req -new -key ${encodedcn}.key -out ${encodedcn}.csr `
                           + `-passin pass:${password} -subj "${config.pki.subj}/${cn}" `
                           + `-reqexts SAN -config <(cat ${config.pki.opensslconf} <(printf "[SAN]\\nsubjectAltName=${dsan}"))`);
      if (csr.code) {
        throw new utils.error.ServerError('req error');
      }
      pki = await models.pki.create({
        days,
        name: encodedcn,
        type: 0,
      });
      if (!pki) {
        throw new utils.error.ServerError('create pki error');
      }

      const crt = await exec('openssl x509 -req -sha256 '
                            + `-days ${days} -passin pass:${config.pki.ca.passin} `
                            + `-in ${encodedcn}.csr -CA ca.crt -CAkey ca.key -set_serial ${pki.id} `
                            + `-out ${encodedcn}.crt -extfile <(cat ${config.pki.ca.x509} <(printf "${x509dsan}"))`);
      if (crt.code) {
        throw new utils.error.ServerError('x509 error');
      }

      const pkcs12 = await exec(`openssl pkcs12 -export -clcerts -passin pass:${password} `
                              + ` -in ${encodedcn}.crt -passout pass:${password} `
                              + `-inkey ${encodedcn}.key -out ${encodedcn}.p12`);
      if (pkcs12.code) {
        throw new utils.error.ServerError('pkcs12 error');
      }
    } catch (e) {
      throw new utils.error.ServerError(e.message);
    }

    const rv = await models.pki.update({
      pkcs12: readFileSync(`${encodedcn}.p12`),
      key: readFileSync(`${encodedcn}.key`),
      csr: readFileSync(`${encodedcn}.csr`),
      crt: readFileSync(`${encodedcn}.crt`),
      is_delete: false,
    }, {
      where: {
        id: pki.id,
      },
    });
    if (!rv) {
      throw new utils.error.ServerError('update pki error');
    }

    // ignore whether we popd right or not right
    popdSync();
    ctx.body = ctx.return;
  },
};
